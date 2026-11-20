import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../contracts/work";

/**
 * Video Notes and the Audio Enhancer as computer tasks (local-first P3d): with the server's video work off a recording or
 * an upload waits with the line and nothing is made on the server; one of the person's computers claims it, makes the
 * same files the server makes on This Mac, and the server files them.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "tasks-sound-"));
mkdirSync(path.join(root, "data"));
process.env.DATA_DIR = path.join(root, "data");
delete process.env.APP_SECRET; // one local account, the admin of an install without sign-in
delete process.env.CT_LOCAL;
delete process.env.DEEPGRAM_API_KEY;
process.env.ELEVENLABS_API_KEY = "not-used";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));
// the speech model is not loaded in a test (This Mac transcribes a note's sound itself)
vi.mock("../lib/device-transcribe", async (real) => ({
  ...(await real<typeof import("../lib/device-transcribe")>()),
  transcribeOnDevice: async () => ({ words: [{ text: "Tiny", start: 0.1, end: 0.4 }], language: "en" }),
}));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { CLAIM_POLL } = await import("./routes");
const { client } = await import("./computer");
const { writeServerWork } = await import("./server-work");
const { runTaskJob, taskFor } = await import("./tasks");
CLAIM_POLL.holdMs = 0;

const ff = (...a: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const seconds = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
// a 3-second recording with picture and sound, and what the Voice Isolator answers for it
const film = path.join(root, "walk.mp4");
ff("-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=f=220:duration=3", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", film);
const isolated = path.join(root, "isolated.wav");
ff("-i", film, "-vn", "-ac", "1", "-ar", "44100", isolated);
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
  String(url).startsWith("https://api.elevenlabs.io/") ? new Response(readFileSync(isolated), { headers: { "content-type": "audio/wav" } }) : realFetch(url, init),
);

const pc = pairDevice("local", "Tiny Mac");
const o = { server: "http://server.test", token: pc.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(app.request(u, i)) };
const c = client(o);
const claim = async (tasks: string[]) => (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks })).task;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (u: string, init?: RequestInit): Promise<any> => (await app.request(u, init)).json();
// under the ffmpeg project's 30 s a test, so a wait that never ends says what it waited for
const until = (fn: () => Promise<unknown>) => vi.waitFor(fn, { timeout: 20_000, interval: 100 });
const at = (...p: string[]) => path.join(process.env.DATA_DIR!, ...p);

/** Runs `upload` on This Mac (the server is the person's computer), then waiting for a computer: both results. */
async function bothRoads<T>(upload: () => Promise<string>, finished: (id: string) => Promise<T>, waits: (id: string) => Promise<void>, kind: string) {
  process.env.CT_LOCAL = "1";
  const here = await finished(await upload());
  delete process.env.CT_LOCAL;
  writeServerWork({ on: false });
  const id = await upload();
  await waits(id);
  const t = await claim([kind]);
  expect(t).toMatchObject({ task: { kind, actor: "local" } });
  expect(await runTaskJob(t!, c, o)).toBe("done");
  return { here, there: await finished(id), id };
}

describe("Video Notes on a computer", () => {
  it("waits with the line, makes nothing on the server, and a computer makes the same picture and length", async () => {
    const upload = async () => (await read("/api/clips?name=Walk&mime=video/mp4", { method: "POST", body: readFileSync(film) })).id as string;
    const finished = async (id: string) => {
      await until(async () => expect((await read(`/api/clips/${id}`)).status).toBe("ready"));
      return { duration: (await read(`/api/clips/${id}`)).duration as number, thumb: readFileSync(at("clips", id, "thumb.jpg")) };
    };
    const { here, there } = await bothRoads(upload, finished, async (id) => {
      await until(async () => expect(await read(`/api/clips/${id}`)).toMatchObject({ status: "processing", note: expect.stringMatching(/^Waits for one of your computers/) }));
      expect(existsSync(at("clips", id, "thumb.jpg"))).toBe(false);
    }, "notes");
    expect(there.duration).toBeCloseTo(here.duration, 2);
    expect(there.duration).toBeGreaterThan(2.9);
    expect(there.thumb.equals(here.thumb)).toBe(true);
  });
});

describe("Audio Enhancer on a computer", () => {
  it("waits with the line, makes nothing on the server, and a computer's run (its engine call through the server) gives the same files", async () => {
    const upload = async () => (await read("/api/enhance?engine=elevenlabs&name=walk.mp4", { method: "POST", body: readFileSync(film) })).id as string;
    const finished = async (id: string) => {
      await until(async () => {
        const s = await read(`/api/enhance/${id}`);
        if (s.status === "error") throw new Error(s.error);
        expect(s.status).toBe("done");
      });
      const s = await read(`/api/enhance/${id}`);
      return { hasVideo: s.hasVideo, videoOutExt: s.videoOutExt, audio: seconds(at("enhance", id, "enhanced.m4a")), video: seconds(at("enhance", id, "enhanced-video.mp4")), source: existsSync(at("enhance", id, "source.m4a")) };
    };
    const { here, there } = await bothRoads(upload, finished, async (id) => {
      expect(await read(`/api/enhance/${id}`)).toMatchObject({ status: "queued", line: expect.stringMatching(/^Waits for one of your computers/) });
      for (const f of ["source.m4a", "enhanced.m4a", "enhanced-video.mp4"]) expect(existsSync(at("enhance", id, f))).toBe(false);
    }, "enhance");
    expect(here).toMatchObject({ hasVideo: true, videoOutExt: "mp4", source: true });
    expect(there).toEqual(here);
  });
});

// a plug-in engine: its own pass leaves a clean sound and hands it to the host's last steps
const { enhanceHost, registerEnhanceEngine } = await import("../enhance");
registerEnhanceEngine({
  id: "tinyclean",
  start: async (host, meta) => {
    const out = path.join(host.sesDir(meta.id), "tiny-out.wav");
    copyFileSync(isolated, out);
    await host.finish(meta.id, meta, out, meta.duration, () => true);
  },
});
// a plug-in engine that runs on one of the person's computers: it converts its input for the computer, then waits for it
registerEnhanceEngine({
  id: "tinypark",
  start: async (host, meta) => {
    const input = path.join(host.sesDir(meta.id), "computer-in.wav");
    await host.runStep(meta.id, meta, "ffmpeg", ["-i", host.stepInput(meta), "-vn", "-ac", "1", "-ar", String(host.sampleRate), "-c:a", "pcm_s16le", "-f", "wav", input]);
    host.setStatus(meta, "queued");
    meta.remote = { state: "waiting", at: Date.now() };
    await host.persist(meta);
  },
});

describe("the Audio Enhancer's last steps and its download at a strength, on a computer", () => {
  const upload = async (engine: string) => (await read(`/api/enhance?engine=${engine}&name=walk.mp4`, { method: "POST", body: readFileSync(film) })).id as string;
  const done = (id: string) =>
    until(async () => {
      const s = await read(`/api/enhance/${id}`);
      if (s.status === "error") throw new Error(s.error);
      expect(s.status).toBe("done");
    });
  const waits = async (id: string) => expect(await read(`/api/enhance/${id}`)).toMatchObject({ status: "queued", line: expect.stringMatching(/^Waits for one of your computers/) });
  const runOne = async (kind: string) => {
    const t = await claim([kind]);
    expect(t).toMatchObject({ task: { kind } });
    expect(await runTaskJob(t!, c, o)).toBe("done");
  };
  const loudness = (f: string) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync(ffmpegCommand(), ["-hide_banner", "-i", f, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr)![1]);

  it("a plug-in engine's run: the loudness and the remux wait for a computer and come out as the server's", async () => {
    process.env.CT_LOCAL = "1";
    const here = await upload("tinyclean");
    await done(here);
    delete process.env.CT_LOCAL;
    writeServerWork({ on: false });
    await claim([]); // the computer names no kinds now: none can take a task, so each waits with the line
    const there = await upload("tinyclean");
    // the engine's pass starts at once; the length, the levelled original, the loudness and the remux wait as one task
    await until(async () => {
      expect(existsSync(at("enhance", there, "finish-in"))).toBe(true);
      await waits(there);
    });
    for (const f of ["source.m4a", "enhanced.m4a"]) expect(existsSync(at("enhance", there, f))).toBe(false);
    await runOne("enhance");
    await done(there);
    expect(existsSync(at("enhance", there, "finish-in"))).toBe(false);
    for (const f of ["source.m4a", "enhanced.m4a", "enhanced-video.mp4"]) expect(seconds(at("enhance", there, f))).toBe(seconds(at("enhance", here, f)));
  });

  it("a plug-in engine that runs on a computer parks for it at once: its input is the upload as is, no task queued, nothing decoded here", async () => {
    delete process.env.CT_LOCAL;
    writeServerWork({ on: false });
    const id = await upload("tinypark");
    await until(async () => expect(await read(`/api/enhance/${id}`)).toMatchObject({ status: "queued", remote: { state: "waiting" } }));
    // the server's convert handed the upload over (the same file), the computer decodes it
    expect(statSync(at("enhance", id, "computer-in.wav")).ino).toBe(statSync(at("enhance", id, "original")).ino);
    expect(taskFor("enhance", id)).toBeUndefined();
    // two saves at once (a run's and its task's) leave one whole save
    const meta = (await enhanceHost.readMeta(id))!;
    await Promise.all([enhanceHost.persist({ ...meta, error: "x".repeat(5000) }), enhanceHost.persist(meta)]);
    expect(() => JSON.parse(readFileSync(at("enhance", id, "meta.json"), "utf8"))).not.toThrow();
  });

  it("a blend waits with the line, nothing made on the server, and a computer's blend matches the server's", async () => {
    process.env.CT_LOCAL = "1";
    const here = await upload("elevenlabs");
    await done(here);
    const local = await app.request(`/api/enhance/${here}/download?mix=0.6`);
    expect(local.status).toBe(200);
    await local.arrayBuffer();
    const there = await upload("elevenlabs");
    await done(there);
    delete process.env.CT_LOCAL;
    writeServerWork({ on: false });
    await claim([]);
    // picking the strength starts it; the download asks and waits
    await app.request(`/api/enhance/${there}/mix`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mix: 0.6 }) });
    const wait = await app.request(`/api/enhance/${there}/download?mix=0.6&ready=1`);
    expect(wait.status).toBe(202);
    expect(await wait.json()).toMatchObject({ ready: false, line: expect.stringMatching(/^Waits for one of your computers/) });
    expect(existsSync(at("enhance", there, "blend-60.m4a"))).toBe(false);
    await runOne("enhance-blend");
    expect(await read(`/api/enhance/${there}/download?mix=0.6&ready=1`)).toEqual({ ready: true });
    const [a, b] = [at("enhance", here, "blend-60.m4a"), at("enhance", there, "blend-60.m4a")];
    expect(seconds(b)).toBe(seconds(a));
    expect(Math.abs(loudness(b) - loudness(a))).toBeLessThan(0.1);
    // the plain link serves the file once it is there
    const file = await app.request(`/api/enhance/${there}/download?mix=0.6`);
    expect([file.status, file.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="walk-enhanced-60.m4a"']);
  });
});
