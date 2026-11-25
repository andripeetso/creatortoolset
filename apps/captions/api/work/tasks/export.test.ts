import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../../contracts/work";
import type { TaskCtx, TaskKind } from "../tasks";

/**
 * Exports as computer tasks: with the server's video work off a render waits with the line and nothing renders on the
 * server; one of the owner's computers renders it, keeps a copy in its Exports folder and sends it, and the file is
 * the same as the one the server renders itself.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "export-task-"));
mkdirSync(path.join(root, "data"));
process.env.DATA_DIR = path.join(root, "data");
process.env.APP_SECRET = "export-task-test-secret";
delete process.env.CT_LOCAL;
delete process.env.CT_MODE;
vi.mock("../../plugins.gen", () => ({ serverPlugins: [] }));
/** Each kind's definition as it registers, so a test can run the export kind by itself. */
const defs = vi.hoisted(() => new Map<string, TaskKind>());
vi.mock("../tasks", async (orig) => {
  const m = await orig<typeof import("../tasks")>();
  return { ...m, taskKind: (k: string, d: TaskKind) => (defs.set(k, d), m.taskKind(k, d)) };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const app = (await import("../../boot")).default;
const { createUser } = await import("../../users");
const { setDeviceWork } = await import("../../lib/devices");
const { CLAIM_POLL } = await import("../routes");
const { client } = await import("../computer");
const { writeServerWork } = await import("../server-work");
const { runTaskJob, taskFor, taskTick } = await import("../tasks");
const { hasTransparentPixels } = await import("./export");
const { ffmpegCommand } = await import("../../ffmpeg-runtime");
CLAIM_POLL.holdMs = 0;

createUser("tiny", "password1");
const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tiny", password: "password1" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const json = { "content-type": "application/json", cookie };
const pc = (await (await app.request("/api/devices", { method: "POST", headers: json, body: JSON.stringify({ name: "Tiny Mac" }) })).json()) as { device: { id: string }; token: string };
const o = { server: "http://server.test", token: pc.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(app.request(u, i)) };
const c = client(o);
const claim = async () => (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks: ["export"] })).task;

const disk = path.join(root, "Tiny Drive");
const exportsDir = disk;
const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 64
PlayResY: 64

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,4,4,4,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Tiny
`;
const start = async () => {
  const res = await app.request("/api/exports", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ kind: "overlay", engine: "native", format: "mov", ass: ASS, name: "Tiny Acrobatics", duration: 0.5, width: 64, height: 64, fps: 10 }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
};
const job = async (id: string) => (await (await app.request(`/api/exports/${id}`, { headers: json })).json()) as { status: string; note?: string; bytes?: number };
const out = (id: string) => path.join(root, "data", "exports", id, "out.mov");
/** The decoded picture's checksum: the same render, wherever it ran. */
const pictureMd5 = (file: string) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "md5", "-"], { encoding: "utf8" }).trim();

describe("exports as computer tasks", () => {
  let byComputer = "";

  it("with the server's video work off a render waits with the line and nothing renders here", async () => {
    writeServerWork({ on: false });
    const id = await start();
    await vi.waitFor(() => expect(taskFor("export", id)?.state).toBe("queued"));
    expect(await job(id)).toMatchObject({ status: "queued", note: expect.stringMatching(/^Waits for one of your computers/) });
    await taskTick();
    expect(taskFor("export", id)?.state).toBe("queued");
    expect(existsSync(out(id))).toBe(false);
  });

  it("one of the owner's computers renders it, keeps a copy in its Exports folder and sends it", async () => {
    const add = await app.request("/api/devices/storage/folders", { method: "POST", headers: json, body: JSON.stringify({ role: "library", host: pc.device.id, path: disk }) });
    expect(add.status, await add.clone().text()).toBe(200);
    const t = await claim();
    expect(t).toMatchObject({ task: { kind: "export", actor: "tiny" }, input: { kind: "overlay", format: "mov" } });
    expect(await runTaskJob(t!, c, o)).toBe("done");
    const id = (t!.input as { id: string }).id;
    expect(await job(id)).toMatchObject({ status: "done", bytes: expect.any(Number) });
    expect(readdirSync(exportsDir)).toEqual(["Tiny Acrobatics-captions-alpha.mov"]);
    byComputer = pictureMd5(out(id));
    expect(pictureMd5(path.join(exportsDir, "Tiny Acrobatics-captions-alpha.mov"))).toBe(byComputer);
  });

  it("with the server's video work on and no computer to take it the server renders the same file", async () => {
    writeServerWork({ on: true });
    setDeviceWork(pc.device.id, { v: WORK_V, steps: [] }); // the computer no longer runs tasks
    try {
      const id = await start();
      await vi.waitFor(async () => expect((await job(id)).status).toBe("done"), { timeout: 30_000 });
      expect(pictureMd5(out(id))).toBe(byComputer);
      expect(readdirSync(exportsDir)).toHaveLength(1); // the server keeps no copy on a computer
    } finally {
      writeServerWork({ on: false });
    }
  });

  it("a burn-in with a cover has the picked frame at frame 0 and the same frame count and sound", async () => {
    const dir = path.join(root, "cover");
    mkdirSync(dir);
    // 1 s at 10 fps, each frame a grey of its own (frame n is n × 25), with a tone under it
    const source = path.join(dir, "source.mp4");
    execFileSync(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=1,geq=lum='N*25':cb=128:cr=128",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    const captions = path.join(dir, "captions.ass");
    writeFileSync(captions, ASS.replace(/^Dialogue:.*$/m, ""));
    const ctx: TaskCtx = { dir, file: async (n) => (n === "source" ? source : captions), call: async () => null, beat: () => {}, signal: new AbortController().signal, where: "server" };
    const input = { id: "cover", kind: "burn", engine: "native", format: "h264", ext: "mp4", filename: "cover.mp4", width: 64, height: 64, fps: 10, duration: 1, coverAt: 0.6 };
    await defs.get("export")!.run(input, ctx);
    // one grey byte per frame
    const greys = execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, "out.mp4"), "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"]);
    expect(greys.length).toBe(10);
    expect(Math.abs(greys[0]! - greys[6]!)).toBeLessThan(4); // frame 6's grey at frame 0
    expect(greys[6]! - greys[1]!).toBeGreaterThan(80); // frame 1 as it was
  });

  it("checks a ProRes sample for real transparency", () => {
    expect(hasTransparentPixels(new Uint8Array())).toBe(false);
    expect(hasTransparentPixels(new Uint8Array([255, 255, 255]))).toBe(false);
    expect(hasTransparentPixels(new Uint8Array([255, 249, 255]))).toBe(true);
  });
});
