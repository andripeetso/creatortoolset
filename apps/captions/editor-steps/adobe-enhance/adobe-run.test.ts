import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";

// A real run in Google Chrome, hidden, against a stand-in of Adobe's page on this machine (never Adobe itself): the
// page's own file input, its three calls, the plan's limit, the two refusals that show only on the page, a signed-out
// profile, a cancel, and the passes on either side of another engine. ADOBE_E2E=1 runs it; ADOBE_E2E_WINDOW=1 also
// opens the sign-in window on screen for a few seconds.
const on = process.env.ADOBE_E2E === "1";
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "adobe-run-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "adobe-run-secret";
process.env.NVIDIA_API_KEY = "nv-test";
process.env.ELEVENLABS_API_KEY = "";
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
// NVIDIA answers with what it got: the passes around Adobe are what's tested
vi.mock("../../api/lib/nvidia-voice", async (orig) => ({
  ...(await orig<typeof import("../../api/lib/nvidia-voice")>()),
  studioVoice: async (_key: string, x: Float32Array) => x,
}));

/* ---- the stand-in ---- */

// "ok" uploads the file and then makes the track (the order seen in a real run); "onepost" sends the file in the POST
// itself, whose answer Chrome keeps no body of
let mode: "ok" | "onepost" | "limited" | "problem" | "signedout" | "slow" | "login" = "ok";
let uploads = 0;
let kept = Buffer.alloc(0);
const page = (m: string) => `<!doctype html><title>Enhance</title>
<script>const loaded = Date.now(); window.adobeIMS = { isSignedInUser: () => ${m === "signedout" ? "false" : m === "login" ? "Date.now() - loaded > 2000" : "true"} };</script>
<input type="file" id="f"><div id="msg"></div>
<script>
f.onchange = async () => {
  if (${m === "problem"}) { msg.textContent = "There was a problem uploading your file"; return; }
  let r;
  if (${m === "onepost"}) r = await fetch("/api/v1/enhance_speech_tracks", { method: "POST", body: f.files[0] });
  else {
    await fetch("/upload/t1", { method: "PUT", body: f.files[0] });
    r = await fetch("/api/v1/enhance_speech_tracks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.files[0].name }) });
  }
  const j = await r.json();
  if (j.limits["is_limited?"]) return;
  for (let i = 0; i < ${m === "slow" ? 20 : 2}; i++) { await new Promise((t) => setTimeout(t, 500)); await fetch("/api/v1/enhance_speech_tracks/" + j.id); }
  await fetch("/api/v1/enhance_speech_tracks/" + j.id + "/enhanced_audio");
};
</script>`;
const standIn = createServer((req, res) => {
  const json = (j: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(j));
  const url = req.url!.split("?")[0]!;
  if (url === "/en/enhance") return void res.writeHead(200, { "content-type": "text/html" }).end(page(mode));
  if ((url === "/api/v1/enhance_speech_tracks" && req.method === "POST") || url === "/upload/t1") {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d)).on("end", () => {
      if (url === "/upload/t1" || mode === "onepost") kept = Buffer.concat(parts);
      if (url === "/upload/t1") return void res.writeHead(200).end();
      uploads++;
      json({ id: "t1", limits: mode === "limited" ? { "is_limited?": true, retry_at_time: new Date(Date.now() + 3600_000).toISOString() } : { "is_limited?": false } });
    });
    return;
  }
  if (url === "/api/v1/enhance_speech_tracks/t1") return json({ id: "t1", error_type: null });
  if (url === "/api/v1/enhance_speech_tracks/t1/enhanced_audio") return json({ url: `http://127.0.0.1:${port()}/files/t1.wav` });
  if (url === "/files/t1.wav") return void res.writeHead(200, { "content-type": "audio/wav" }).end(kept);
  res.writeHead(404).end();
});
await new Promise<void>((r) => standIn.listen(0, "127.0.0.1", r));
const port = () => (standIn.address() as AddressInfo).port;
afterAll(() => standIn.close());
process.env.ADOBE_ENHANCE_URL = `http://127.0.0.1:${port()}/en/enhance`;

/* ---- the app ---- */

const { adobe } = await import("./engine");
adobe.signInWaitMs = 4000;
const app = (await import("../../api/boot")).default;
const res = await app.request("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "adobe-run-secret" }),
});
const h = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (p: string): Promise<any> => (await app.request(p, { headers: h })).json();
const files = path.join(dataDir, "plugins", "adobe-enhance", "admin");
const signIn = () => {
  mkdirSync(files, { recursive: true });
  writeFileSync(path.join(files, "signed-in"), "now");
};
const tone = (() => {
  const f = path.join(dataDir, "tone.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=3", "-ar", "48000", f]);
  return readFileSync(f);
})();
const upload = async (q: string) => {
  const r = await app.request(`/api/enhance?name=tone.wav&${q}`, { method: "POST", headers: h, body: tone });
  const j = (await r.json()) as { id: string };
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j.id as string;
};
const until = async (id: string, want: (s: { status: string }) => boolean, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    const s = await get(`/api/enhance/${id}`);
    if (want(s)) return s;
  }
  throw new Error(`timed out: ${JSON.stringify(await get(`/api/enhance/${id}`))}`);
};
const over = (s: { status: string }) => s.status === "done" || s.status === "error";

describe.skipIf(!on)("Adobe Enhance Speech in Chrome, against a stand-in of Adobe's page", () => {
  it("enhances a file: the page's upload, its three calls, the result at the Audio Enhancer's loudness", async () => {
    signIn();
    mode = "ok";
    uploads = 0;
    const id = await upload("engine=adobespeech");
    const s = await until(id, over);
    expect(s).toMatchObject({ status: "done", engine: "adobespeech", hasEnhanced: true, progress: 1 });
    expect(uploads).toBe(1);
    expect((await app.request(`/api/enhance/${id}/play?which=enhanced`, { headers: h })).status).toBe(200);
    // the pass's own files go right after
    const left = () => ["adobe-in.wav", "adobe-out.wav"].filter((f) => existsSync(path.join(dataDir, "enhance", id, f)));
    for (const end = Date.now() + 3000; left().length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
    expect(left()).toEqual([]);
  });

  it("runs as either pass of two: after NVIDIA (the file in the POST itself), and before it", async () => {
    signIn();
    for (const q of ["engine=nvidia&then=adobespeech", "engine=adobespeech&then=nvidia"]) {
      mode = q.startsWith("engine=nvidia") ? "onepost" : "ok";
      const s = await until(await upload(q), over);
      expect(s, q).toMatchObject({ status: "done", hasEnhanced: true });
    }
  });

  it("the plan's daily limit: one plain line, and Adobe held off until the time it gave, the other engines kept", async () => {
    signIn();
    onTestFinished(() => rmSync(path.join(files, "off.json"), { force: true }));
    mode = "limited";
    const s = await until(await upload("engine=adobespeech"), over);
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/^You used up today's Adobe time\. It comes back at \d{1,2}:\d\d(\s?[AP]M)?\.$/);
    const a = await get("/api/enhance/availability");
    expect(a).toMatchObject({ adobespeech: false, nvidia: true, default: "nvidia" });
    expect(a.why.adobespeech).toMatch(/^Today's Adobe time is used up, back at \d{1,2}:\d\d(\s?[AP]M)?$/);
  });

  it("the end of the day's time, which Adobe shows only on its page: one plain line, not held off", async () => {
    signIn();
    mode = "problem";
    const s = await until(await upload("engine=adobespeech"), over);
    expect(s).toMatchObject({ status: "error", error: "Adobe took no upload. Your time left today may be shorter than this file." });
    expect((await get("/api/enhance/availability")).adobespeech).toBe(true);
  });

  it("signed out at Adobe: one plain line, and the engine waits for a new sign-in", async () => {
    signIn();
    mode = "signedout";
    uploads = 0;
    const s = await until(await upload("engine=adobespeech"), over);
    expect(s).toMatchObject({ status: "error", error: "You are signed out of Adobe. Sign in again in Settings → Adobe Enhance Speech." });
    expect(uploads).toBe(0);
    expect((await get("/api/x/adobe-enhance")).signedIn).toBe(false);
    expect((await get("/api/enhance/availability")).why.adobespeech).toBe("Needs an Adobe sign-in");
  });

  it("a cancel mid-run closes Chrome and leaves the file as it was; the next run goes through", async () => {
    signIn();
    mode = "slow";
    uploads = 0;
    const id = await upload("engine=adobespeech");
    for (const end = Date.now() + 30_000; uploads === 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 200));
    const c = await (await app.request(`/api/enhance/${id}/cancel`, { method: "POST", headers: h })).json();
    expect(c).toMatchObject({ status: "ready", progress: 0 });
    await new Promise((r) => setTimeout(r, 3000));
    expect(await get(`/api/enhance/${id}`)).toMatchObject({ status: "ready", hasEnhanced: false });
    mode = "ok";
    expect(await until(await upload("engine=adobespeech"), over)).toMatchObject({ status: "done" });
  });

  it.skipIf(process.env.ADOBE_E2E_WINDOW !== "1")("Sign in: a Chrome window on the page, closed by itself once the page says the person is in", async () => {
    rmSync(files, { recursive: true, force: true });
    mode = "login";
    expect(await (await app.request("/api/x/adobe-enhance/signin", { method: "POST", headers: h })).json()).toMatchObject({ signingIn: true });
    for (const end = Date.now() + 40_000; (await get("/api/x/adobe-enhance")).signingIn && Date.now() < end; ) await new Promise((r) => setTimeout(r, 500));
    expect(await get("/api/x/adobe-enhance")).toMatchObject({ signingIn: false, signedIn: true, error: null });
    expect(existsSync(path.join(files, "chrome-profile"))).toBe(true);
  });
});
