import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "guest-"));
process.env.APP_SECRET = "guest-test-secret";
process.env.DEEPGRAM_API_KEY = "dg-test";
process.env.ANTHROPIC_API_KEY = "sk-ant-test";

const { createUser, GUEST_USER } = await import("./users");
const { takeGuest } = await import("./guest");
const app = (await import("./boot")).default;

const tryAsGuest = async () =>
  (await app.request("/api/auth/guest", { method: "POST" }))
    .headers.get("set-cookie")!.split(";")[0];

/** A 16 kHz mono 16-bit WAV of `seconds` of silence. */
function wav(seconds: number): Uint8Array {
  const n = Math.round(seconds * 16000) * 2;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WAVEfmt "].map((c) => c.charCodeAt(0)), 8);
  v.setUint32(16, 16, true);
  v.setUint32(24, 16000, true);
  b.set([..."data"].map((c) => c.charCodeAt(0)), 36);
  v.setUint32(40, n, true);
  return b;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guest mode", () => {
  it("gives every guest its own name, shown as plain 'guest'", async () => {
    const [a, b] = [await tryAsGuest(), await tryAsGuest()];
    expect(a).not.toBe(b);
    const me = (await (await app.request("/api/auth/check", { headers: { cookie: a } })).json()) as { user: object };
    expect(me.user).toMatchObject({ username: "guest", role: "guest" });
    expect(() => createUser("guest-0123456789ab", "password1")).toThrow(/reserved/);
  });

  it("refuses videos over 3 minutes before Deepgram sees them, logs the rest", async () => {
    const cookie = await tryAsGuest();
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: { channels: [{ alternatives: [{ words: [{ word: "hi", punctuated_word: "Hi.", start: 0, end: 0.4 }] }] }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const post = (seconds: number) =>
      app.request("/api/transcribe", {
        method: "POST",
        headers: { cookie, "content-type": "audio/wav", "x-file-name": encodeURIComponent("my reel.mp4") },
        body: wav(seconds),
      });
    expect((await post(181)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await post(60)).status).toBe(200);
    expect(String((fetchMock.mock.calls as unknown as [string][])[0][0])).toContain("mip_opt_out=true");

    const admin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "guest-test-secret" }),
    });
    const list = (await (
      await app.request("/api/admin/guests", { headers: { cookie: admin.headers.get("set-cookie")!.split(";")[0] } })
    ).json()) as { runs: object[]; today: { seconds: number } };
    expect(list.runs[0]).toMatchObject({ file: "my reel.mp4", seconds: 60, text: "Hi." });
    expect(list.today.seconds).toBe(60);
  });

  it("gets the AI pass only on the API key, and only once an admin switches it on for guests", async () => {
    const cookie = await tryAsGuest();
    const available = async () =>
      ((await (await app.request("/api/ai/available", { headers: { cookie } })).json()) as { allowed: boolean }).allowed;
    expect(await available()).toBe(false); // off by default: guests get no AI at all

    const { saveSettings } = await import("./lib/providers");
    const { DEFAULT_SETTINGS } = await import("../contracts/providers");
    await saveSettings({ ...DEFAULT_SETTINGS, api: { ...DEFAULT_SETTINGS.api, guests: true } });
    expect(await available()).toBe(true);
    const fetchMock = vi.fn(async () => new Response("usage limit reached", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/api/ai/segment", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ words: [{ text: "Hi.", start: 0, end: 0.4 }] }),
    });
    expect(await res.json()).toMatchObject({ code: "OUT_OF_TOKENS", error: expect.stringMatching(/^Free guest uses have run out/) });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [url] of fetchMock.mock.calls as unknown as [string][]) expect(url).toMatch(/\/v1\/messages$/); // the Anthropic API
  });

  it("caps one guest a day, then all guests together", () => {
    const g = (username: string) => ({ ...GUEST_USER, username });
    expect(takeGuest(g("cap-a"), "seconds", 170)).toBeNull();
    expect(takeGuest(g("cap-a"), "seconds", 500)).toMatch(/today's guest allowance/);
    for (const n of ["cap-b", "cap-c", "cap-d", "cap-e", "cap-f"]) {
      expect(takeGuest(g(n), "seconds", 600)).toBeNull();
    }
    expect(takeGuest(g("cap-g"), "seconds", 600)).toMatch(/limit for today/);
  });

  it("uses the Audio Enhancer (NVIDIA only, a daily cap)", async () => {
    const cookie = await tryAsGuest();
    const me = (await (await app.request("/api/auth/check", { headers: { cookie } })).json()) as { user: { off: string[] } };
    expect(me.user.off).not.toContain("enhance");
    const avail = await app.request("/api/enhance/availability", { headers: { cookie } });
    expect(avail.status).toBe(200);
    expect(await avail.json()).toMatchObject({ elevenlabs: false, default: "nvidia" });
    const g = { ...GUEST_USER, username: "enh-a" };
    expect(takeGuest(g, "enhance", 180)).toBeNull();
    expect(takeGuest(g, "enhance", 500)).toMatch(/today's guest allowance/);
  });

  it("uses Review under a daily upload cap, without Caption Studio projects on the server", async () => {
    const cookie = await tryAsGuest();
    const headers = { cookie, "content-type": "application/json" };
    const post = (p: string, body?: unknown) =>
      app.request(`/api/review${p}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const me = (await (await app.request("/api/auth/check", { headers: { cookie } })).json()) as { user: { off: string[] } };
    expect(me.user.off).not.toContain("review");
    expect((await app.request("/api/review", { headers })).status).toBe(200);

    const bytes = Buffer.from("a guest cut");
    const init = (await (await post("/uploads", { name: "cut.mp4", size: bytes.length })).json()) as { id: string; partSize: number };
    await app.request(`/api/review/uploads/${init.id}/parts/1`, {
      method: "POST",
      headers: { cookie, "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
      body: bytes,
    });
    const asset = (await (await post(`/uploads/${init.id}/complete`)).json()) as { id: string };
    expect((await post(`/assets/${asset.id}/v/1/captions`)).status).toBe(403);

    expect((await post("/uploads", { name: "big.mov", size: 3 * 1024 ** 3 })).status).toBe(429);
  });
});
