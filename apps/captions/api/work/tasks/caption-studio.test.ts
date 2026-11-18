import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../../contracts/work";
import type { AuthVars } from "../../auth";

/**
 * Caption Studio's processing as computer tasks: This Mac makes a clip's editing copy at once, under Upload none too;
 * an own server with its video work off queues it with the wait line and makes nothing itself, and a computer's claim
 * gives the same result the server gave. The same for the sound the auto-captions hear. The upload routes ask mayReceive.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "caption-studio-tasks-"));
mkdirSync(path.join(root, "data"));
process.env.DATA_DIR = path.join(root, "data");
process.env.APP_SECRET = "caption-studio-tasks-secret";
delete process.env.CT_LOCAL;
delete process.env.CT_MODE;
vi.mock("../../plugins.gen", () => ({ serverPlugins: [] }));
// what the sound task hands the hearing, kept: the words are heard on the person's key (captions.test.ts covers that)
const heard: { where: string; peaks: number[]; wav: Buffer }[] = [];
vi.mock("../../captions-job", async (real) => ({
  ...(await real<typeof import("../../captions-job")>()),
  captionsHeard: async (_actor: string, _input: unknown, sound: { peaks: number[] }, files: Record<string, string>) =>
    void heard.push({ where: files["audio.f32"] ? "server" : "computer", peaks: sound.peaks, wav: readFileSync(files["audio.wav"]!) }),
}));

const boot = (await import("../../boot")).default;
const { projectsApp } = await import("../../projects");
const { pairDevice } = await import("../../lib/devices");
const { libraryDb } = await import("../../library/db");
const { REFUSED_NONE } = await import("../../library/upload-gate");
const { WAITS_FOR_COMPUTER } = await import("../../library/jobs");
const { CLAIM_POLL } = await import("../routes");
const { client } = await import("../computer");
const { writeServerWork } = await import("../server-work");
const { runTaskJob, startTask, taskFor } = await import("../tasks");
const { ffmpegCommand } = await import("../../ffmpeg-runtime");
CLAIM_POLL.holdMs = 0;
afterAll(() => {
  delete process.env.CT_LOCAL;
  rmSync(root, { recursive: true, force: true });
});

// Tiny Acrobatics' own library keeps its files on her computers
libraryDb()
  .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_tiny', 'tinyacrobatics', 'Tiny Acrobatics', 'local', ?, 0)")
  .run('{"upload":"none","proxy":false,"describe":false,"embed":false}');

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "tiny", role: "user", cloud: false, off: [] });
  return next();
});
app.route("/api/projects", projectsApp);

const video = path.join(root, "roll.mp4");
execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=1.5", "-f", "lavfi", "-i", "sine=frequency=330:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
const bytes = readFileSync(video);

const clipDir = (id: string, clip: string) => path.join(root, "data", "projects", id, "clips", clip);
const upload = (route: string) => app.request(route, { method: "POST", body: bytes });
type Made = { id?: string; clipId: string; srcWidth: number; srcHeight: number; srcFps?: number; proxyWait?: string; error?: string };
const meta = (id: string) => JSON.parse(readFileSync(path.join(root, "data", "projects", id, "meta.json"), "utf8")) as { clips: { id: string; srcWidth?: number; srcHeight?: number; srcFps?: number }[] };

const pc = pairDevice("tiny", "Tiny Mac");
const o = { server: "http://server.test", token: pc.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(boot.request(u, i)) };
const c = client(o);
const claim = async (tasks: string[]) => (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks })).task;

let onMac: Made;
let projectId = "";

describe("Caption Studio on a fresh This Mac, its library under Upload none", () => {
  it("takes the video and makes its editing copy, picture and probe at once", async () => {
    process.env.CT_LOCAL = "1";
    try {
      const r = await upload("/api/projects?name=Tiny%20Acrobatics&clip=roll.mp4");
      expect(r.status).toBe(200);
      onMac = (await r.json()) as Made;
      projectId = onMac.id!;
      expect(onMac).toMatchObject({ srcWidth: 320, srcHeight: 240, srcFps: 25 });
      expect(onMac.proxyWait).toBeUndefined();
      for (const f of ["original", "proxy.mp4", "thumb.jpg"]) expect(existsSync(path.join(clipDir(projectId, onMac.clipId), f)), f).toBe(true);
      // the Mac's own file is the server's own here: taken, its library's none or not
      expect((await upload(`/api/projects/${projectId}/clips?name=two.mp4&fromPath=/Users/tiny/Movies/two.mp4`)).status).toBe(200);
      // and its sound for the captions is cut here too
      await startTask("caption-sound", projectId, "tiny", null, { project: projectId, clip: onMac.clipId, cloud: true, seconds: 1.5, name: "Tiny Acrobatics" });
      expect(heard.map((h) => h.where)).toEqual(["server"]);
    } finally {
      delete process.env.CT_LOCAL;
    }
  });
});

describe("an own server with its video work off", () => {
  let added: Made;

  it("queues the editing copy with the wait line and makes nothing itself", async () => {
    writeServerWork({ on: false });
    const r = await upload(`/api/projects/${projectId}/clips?name=three.mp4`);
    expect(r.status).toBe(200);
    added = (await r.json()) as Made;
    expect(added).toMatchObject({ srcWidth: 0, proxyWait: WAITS_FOR_COMPUTER });
    expect(existsSync(path.join(clipDir(projectId, added.clipId), "original"))).toBe(true);
    expect(existsSync(path.join(clipDir(projectId, added.clipId), "proxy.mp4"))).toBe(false);
    const status = (await (await app.request(`/api/projects/${projectId}/clips/${added.clipId}/original/status`)).json()) as { proxyReady: boolean; proxyWait?: string };
    expect(status).toMatchObject({ proxyReady: false, proxyWait: WAITS_FOR_COMPUTER });
  });

  it("her computer claims it and the server files what it made: the same as the server made", async () => {
    const t = await claim(["caption-ingest", "caption-sound"]);
    expect(t).toMatchObject({ task: { kind: "caption-ingest", actor: "tiny" } });
    expect(await runTaskJob(t!, c, o)).toBe("done");
    const dir = clipDir(projectId, added.clipId);
    expect(existsSync(path.join(dir, "proxy.mp4"))).toBe(true);
    expect(existsSync(path.join(dir, "thumb.jpg"))).toBe(true);
    const mine = meta(projectId).clips.find((x) => x.id === added.clipId)!;
    expect({ srcWidth: mine.srcWidth, srcHeight: mine.srcHeight, srcFps: mine.srcFps }).toEqual({ srcWidth: onMac.srcWidth, srcHeight: onMac.srcHeight, srcFps: onMac.srcFps });
    expect(taskFor("caption-ingest", `${projectId}/${added.clipId}`)?.state).toBe("done");
    const status = (await (await app.request(`/api/projects/${projectId}/clips/${added.clipId}/original/status`)).json()) as { proxyReady: boolean; proxyWait?: string };
    expect(status.proxyReady).toBe(true);
    expect(status.proxyWait).toBeUndefined();
  });

  it("the captions' sound waits, is cut by her computer and is the same sound This Mac cut", async () => {
    const got = await startTask("caption-sound", projectId, "tiny", null, { project: projectId, clip: onMac.clipId, cloud: true, seconds: 1.5, name: "Tiny Acrobatics" });
    // her computer named its kinds at its last claim: it can take it, so no line
    expect(got.state).toBe("queued");
    const t = await claim(["caption-ingest", "caption-sound"]);
    expect(t?.task.kind).toBe("caption-sound");
    expect(await runTaskJob(t!, c, o)).toBe("done");
    expect(heard.map((h) => h.where)).toEqual(["server", "computer"]);
    expect(heard[1]!.peaks).toEqual(heard[0]!.peaks);
    expect(heard[1]!.wav.equals(heard[0]!.wav)).toBe(true);
  });

  it("the upload routes refuse a computer's own file with the line; a person's upload is taken", async () => {
    const r = await upload("/api/projects?name=x&fromPath=/Users/tiny/Movies/roll.mp4");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: REFUSED_NONE, code: "upload_refused" });
    const chunk = await app.request(`/api/projects/${projectId}/clips/${onMac.clipId}/original/chunk?fromPath=/Users/tiny/Movies/roll.mp4`, {
      method: "POST",
      headers: { "upload-offset": "0", "upload-length": "4", "content-length": "4" },
      body: "abcd",
    });
    expect(chunk.status).toBe(409);
    const taken = await upload(`/api/projects/${projectId}/clips?name=four.mp4`);
    expect([taken.status, ((await taken.json()) as Made).error]).toEqual([200, undefined]);
  });
});
