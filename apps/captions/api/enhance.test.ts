import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "enhance-"));
process.env.NVIDIA_API_KEY = "";
process.env.ELEVENLABS_API_KEY = "";
// NVIDIA answers with what it got: the passes' plumbing is what's tested here
vi.mock("./lib/nvidia-voice", async (orig) => ({
  ...(await orig<typeof import("./lib/nvidia-voice")>()),
  studioVoice: async (_key: string, x: Float32Array) => x,
}));
const { enhanceApp, ENHANCE_MOVES } = await import("./enhance");
const { saveMyKey } = await import("./my-keys");
const { IllegalTransition, move } = await import("./lib/transition");

// x-as: a username; "local" = the admin of an install without sign-in (its sessions run on the server's keys)
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  const as = c.req.header("x-as") ?? "local";
  c.set("user", { username: as, role: as === "local" ? "admin" : "user", cloud: false, off: [] });
  await next();
});
app.route("/", enhanceApp);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const as = (who: string, method = "GET", body?: RequestInit["body"]): RequestInit => ({ method, headers: { "x-as": who }, body });
const tone = (seconds: number) => {
  const f = path.join(process.env.DATA_DIR!, `tone${seconds}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=220:d=${seconds}`, "-ar", "16000", f]);
  return readFileSync(f);
};
const until = async <T,>(fn: () => Promise<T | null>, ms = 15_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error("timed out");
};

describe("Audio Enhancer engines", () => {
  it("runs on the owner's key: the admin's from the server, a member's own, never the server's for a member", async () => {
    expect(await read(app.request("/availability", as("local")))).toMatchObject({ nvidia: false, elevenlabs: false, default: "nvidia" });
    process.env.ELEVENLABS_API_KEY = "not-used";
    expect(await read(app.request("/availability", as("local")))).toMatchObject({ elevenlabs: true });
    expect(await read(app.request("/availability", as("jordan")))).toMatchObject({ elevenlabs: false, default: "nvidia" });
    // a member without a key: told which key to add, the server's key never used for them
    expect((await read(app.request("/availability", as("jordan")))).why).toMatchObject({ elevenlabs: "Add your ElevenLabs key in Settings → My API keys" });
    expect((await read(app.request("/?engine=elevenlabs", as("jordan", "POST", tone(1))))).error).toBe("Add your ElevenLabs key in Settings → My API keys");
    saveMyKey("jordan", "ELEVENLABS_API_KEY", "jordans-own");
    expect(await read(app.request("/availability", as("jordan")))).toMatchObject({ elevenlabs: true });
    saveMyKey("jordan", "ELEVENLABS_API_KEY", null);
    process.env.ELEVENLABS_API_KEY = "";
    expect((await read(app.request("/?engine=nvidia&name=a.wav", as("local", "POST", tone(1))))).error).toMatch(/Add your NVIDIA key/);
    expect((await read(app.request("/?engine=kestrel", as("local", "POST", tone(1))))).error).toMatch(/Engine is one of/);
  });

});

describe("Audio Enhancer status moves", () => {
  it("a finished session only starts a new run; a failed one can too; nothing goes done → running", () => {
    expect(() => move(ENHANCE_MOVES, "done", "running", "t")).toThrow(IllegalTransition);
    expect(() => move(ENHANCE_MOVES, "error", "done", "t")).toThrow(IllegalTransition);
    expect(move(ENHANCE_MOVES, "error", "queued", "t")).toBe("queued");
    expect(move(ENHANCE_MOVES, "running", "ready", "t")).toBe("ready"); // a cancel
  });
});

describe("Audio Enhancer passes and strength", () => {
  const done = (id: string) => until(async () => {
    const m = await read(app.request(`/${id}`, as("local")));
    if (m.status === "error") throw new Error(m.error);
    return m.status === "done" ? m : null;
  });

  it("a second pass is an admin's, with another engine", async () => {
    process.env.NVIDIA_API_KEY = "not-used";
    expect(await read(app.request("/availability", as("local")))).toMatchObject({ admin: true });
    expect(await read(app.request("/availability", as("jordan")))).toMatchObject({ admin: false });
    expect((await read(app.request("/?engine=nvidia&then=elevenlabs", as("jordan", "POST", tone(1))))).error).toMatch(/for admins/);
    expect((await read(app.request("/?engine=nvidia&then=nvidia", as("local", "POST", tone(1))))).error).toMatch(/another engine/);
    expect((await read(app.request("/?engine=nvidia&then=elevenlabs", as("local", "POST", tone(1))))).error).toMatch(/Add your ElevenLabs key/);
    process.env.NVIDIA_API_KEY = "";
  });

  it("keeps the strength and downloads the blend at it", async () => {
    process.env.NVIDIA_API_KEY = "not-used";
    const s = await read(app.request("/?engine=nvidia&name=mix.wav", as("local", "POST", tone(2))));
    await done(s.id);
    process.env.NVIDIA_API_KEY = "";
    expect((await app.request(`/${s.id}/mix`, as("local", "PUT", JSON.stringify({ mix: 2 })))).status).toBe(400);
    expect((await read(app.request(`/${s.id}/mix`, as("local", "PUT", JSON.stringify({ mix: 0.62 }))))).mix).toBe(0.6);
    const r = await app.request(`/${s.id}/download`, as("local"));   // the kept strength
    expect([r.status, r.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="mix-enhanced-60.m4a"']);
    expect(existsSync(path.join(process.env.DATA_DIR!, "enhance", s.id, "blend-60.m4a"))).toBe(true);
    const full = await app.request(`/${s.id}/download?mix=1`, as("local"));
    expect(full.headers.get("content-disposition")).toMatch(/mix-enhanced\.m4a/);
  });
});
