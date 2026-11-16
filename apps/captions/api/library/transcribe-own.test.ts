import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TRANSCRIBE_KIND } from "../../contracts/devices";
import { WORK_V, type LibraryPackage } from "../../contracts/work";

/**
 * Item 6B: a library transcript made on a computer has its sound cut on that computer, from its own copy, never on the
 * server: on a computer's speech model (the speech road) and on the person's key (the library road, /hear). The words
 * filed are the ones the server's own cut gives.
 */
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "transcribe-own-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "transcribe-own-secret";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
delete process.env.DEEPGRAM_API_KEY;
delete process.env.OPENAI_API_KEY;
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

/** Every sound cut through the library's ffmpeg (16 kHz mono), by its output file: the server's are named transcribe-*. */
const cuts: string[] = [];
vi.mock("./media/run", async (load) => {
  const m = await load<typeof import("./media/run")>();
  return {
    ...m,
    ffmpegTo: (out: string, args: string[], soon?: boolean) => {
      if (args.includes("-vn") && args.includes("16000")) cuts.push(out);
      return m.ffmpegTo(out, args, soon);
    },
  };
});
const serverCuts = () => cuts.filter((c) => path.basename(c).startsWith("transcribe-"));

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { writeVoicePrefs } = await import("../lib/speech");
const { saveMyKey } = await import("../my-keys");
const { blobs, libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { probe } = await import("./media/probe");
const { soundArgs } = await import("./transcribe");
const { tick } = await import("./worker");
const { runLibraryJob } = await import("../work/library");

const TURBO = "whisper-large-v3-turbo";
const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { stdio: "pipe" });
const json = (body: unknown, token: string) => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

/** The PCM of a WAV (its data chunk). */
const pcmOf = (wav: Uint8Array) => {
  const b = Buffer.from(wav);
  const at = b.indexOf("data", 12);
  return b.subarray(at + 8);
};
/** What a stand-in speech engine hears in a WAV: two words named by its sound, ending with it. Same sound, same words. */
const heardIn = (wav: Uint8Array) => {
  const pcm = pcmOf(wav);
  const h = createHash("sha256").update(pcm).digest("hex");
  return [
    { text: h.slice(0, 8), start: 0, end: 0.5 },
    { text: h.slice(8, 16), start: 0.6, end: Math.round((pcm.length / 32000) * 1000) / 1000 },
  ];
};

const db = libraryDb();
const pc = pairDevice("tiny", "Tiny PC");
const file = path.join(dir, "Movies", "tiny-flip.mp4");
const transcript = (v: string) => db.prepare("SELECT provider, model, text, segments, words FROM transcripts WHERE version_id = ?").get(v) as Record<string, string>;
const rows = (t: Record<string, string>) => ({ text: t.text, segments: JSON.parse(t.segments), words: JSON.parse(t.words) });
let reference: ReturnType<typeof rows>;
let deepgramBodies = 0;

beforeAll(async () => {
  createUser("tiny", "password1");
  // a picture and two sound tracks, the second with more channels: ffmpeg's own pick, wherever it cuts
  mkdirSync(path.dirname(file), { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-filter_complex", "[2:a]pan=stereo|c0=c0|c1=c0[st]",
    "-map", "0:v", "-map", "1:a", "-map", "[st]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", file]);
  db.exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_t', 'tiny', 'Tiny Acrobatics', 'local', '{"embed":false,"describe":false}', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_t', 'lib_t', 'video', 'tiny-flip.mp4', 'tiny', 0);`);
  await blobs.put("libraries/lib_t/v/ver_t/source", file);
  db.prepare(`INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, probe, created_by, created_at)
    VALUES ('ver_t', 'ast_t', 1, 'libraries/lib_t/v/ver_t/source', ?, 'x', 'ready', ?, 'tiny', 0)`).run(statSync(file).size, JSON.stringify(await probe(file)));
  // Deepgram, standing in: what it hears is named by the sound sent
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).includes("deepgram")) throw new Error(`unexpected fetch ${url}`);
    deepgramBodies++;
    const words = heardIn(new Uint8Array(init!.body as ArrayBuffer));
    return Response.json({
      results: { channels: [{ alternatives: [{ words: words.map((w) => ({ word: w.text, punctuated_word: w.text, start: w.start, end: w.end })) }] }], utterances: [{ start: 0, end: 2 }] },
    });
  });
  // the server's own transcript of the clip, on the person's key, before any computer is about
  saveMyKey("tiny", "DEEPGRAM_API_KEY", "dg-tiny");
  writeVoicePrefs("tiny", { languages: [], stt: { default: { engine: "deepgram" } } });
  enqueueJob(db, "lib_t", "ver_t", "transcribe", "tiny");
  expect(await tick(Date.now(), ["transcribe"])).toBe(true);
  expect(serverCuts()).toHaveLength(1);
  reference = rows(transcript("ver_t"));
  expect(reference.words).toHaveLength(2);
  cuts.length = 0;
}, 60_000);
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("a computer's transcript of a library file", () => {
  it("on its speech model: the computer cuts the sound from its own copy; the server decodes none", async () => {
    db.prepare("UPDATE asset_versions SET mac_path = ?, mac_device = ? WHERE id = 'ver_t'").run(file, pc.device.id);
    await app.request("/api/devices/relay/report", json({ drivers: [], homes: [], machine: { os: "linux", cpus: 8, memGb: 16, freeGb: 20 } }, pc.token));
    const claim = async () =>
      (await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [TRANSCRIBE_KIND], models: [TURBO] }, pc.token))).json()) as {
        job: { id: number; kind: string; model: string; options?: Record<string, string> } | null;
      };
    await claim();
    writeVoicePrefs("tiny", { stt: { default: { engine: "local", model: TURBO } } });
    enqueueJob(db, "lib_t", "ver_t", "transcribe", "tiny", true);
    const running = tick(Date.now(), ["transcribe"]);
    let job = (await claim()).job;
    for (let i = 0; !job && i < 100; i++) job = (await new Promise((r) => setTimeout(r, 50)), await claim()).job;
    expect(job).toMatchObject({ kind: TRANSCRIBE_KIND, model: TURBO, options: { version: "ver_t", path: file, bytes: String(statSync(file).size) } });
    expect(job!.options!.proxy).toBeUndefined(); // the server has no proxy of it: the computer reads its own file

    // the computer: the server's own cut, run there on its copy
    const own = path.join(dir, "computer.wav");
    ff(["-i", job!.options!.path!, ...soundArgs(true), own]);
    const sent = await app.request(`/api/devices/relay/transcribe/${job!.id}`, json({ words: heardIn(readFileSync(own)), language: "en" }, pc.token));
    expect(sent.status).toBe(200);
    expect(await running).toBe(true);

    expect(serverCuts()).toEqual([]); // 0 sound decodes on the server
    const t = transcript("ver_t");
    expect(t).toMatchObject({ provider: "computer", model: TURBO });
    expect(rows(t)).toEqual(reference); // the same words at the same times as the server-made one
  }, 60_000);

  it("an older computer that asks for the audio gets the server's cut then, and it is the same sound", async () => {
    enqueueJob(db, "lib_t", "ver_t", "transcribe", "tiny", true);
    const running = tick(Date.now(), ["transcribe"]);
    const claim = async () =>
      (await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [TRANSCRIBE_KIND], models: [TURBO] }, pc.token))).json()) as { job: { id: number } | null };
    let job = (await claim()).job;
    for (let i = 0; !job && i < 100; i++) job = (await new Promise((r) => setTimeout(r, 50)), await claim()).job;
    expect(serverCuts()).toEqual([]); // nothing cut until it asks
    const audio = new Uint8Array(await (await app.request(`/api/devices/relay/transcribe/${job!.id}`, { headers: { authorization: `Bearer ${pc.token}` } })).arrayBuffer());
    expect(serverCuts()).toHaveLength(1);
    expect(pcmOf(audio).equals(pcmOf(readFileSync(path.join(dir, "computer.wav"))))).toBe(true);
    await app.request(`/api/devices/relay/transcribe/${job!.id}`, json({ words: heardIn(audio), language: "en" }, pc.token));
    expect(await running).toBe(true);
    expect(rows(transcript("ver_t"))).toEqual(reference);
    cuts.length = 0;
  }, 60_000);

  it("on the person's key: the uploader's computer cuts the sound, the server only hears it; the rows come back in the result", async () => {
    writeVoicePrefs("tiny", { stt: { default: { engine: "deepgram" } } });
    const work = async () =>
      (await (await app.request("/api/devices/relay/work/claim", json({ v: WORK_V, steps: [], library: true }, pc.token))).json()) as { lib?: LibraryPackage };
    await work(); // its worker says it runs library jobs
    db.prepare("DELETE FROM transcripts WHERE version_id = 'ver_t'").run();
    enqueueJob(db, "lib_t", "ver_t", "transcribe", "tiny", true);
    expect(await tick(Date.now(), ["transcribe"])).toBe(false); // left to the computer that has the file
    const { lib } = await work();
    expect(lib).toMatchObject({ job: { kind: "transcribe", versionId: "ver_t" }, audio: "wav", file: { path: file } });
    const before = deepgramBodies;
    const posted: string[] = [];
    const o = {
      server: "http://server.test",
      token: pc.token,
      beatMs: 50,
      fetch: (u: string, i?: RequestInit) => {
        posted.push(`${i?.method ?? "GET"} ${new URL(u).pathname.split("/").slice(-1)[0]}`);
        return Promise.resolve(app.request(u, i));
      },
    };
    expect(await runLibraryJob(lib!, o)).toBe("done");
    expect(posted.filter((p) => !p.endsWith("beat"))).toEqual(["POST hear", "POST done"]);
    expect(deepgramBodies).toBe(before + 1);
    expect(serverCuts()).toEqual([]); // the only cut was the computer's own
    expect(cuts).toHaveLength(1);
    const t = transcript("ver_t");
    expect(t.provider).toBe("deepgram");
    expect(rows(t)).toEqual(reference);
    expect((db.prepare("SELECT state FROM jobs WHERE version_id = 'ver_t' AND kind = 'transcribe' ORDER BY id DESC").get() as { state: string }).state).toBe("done");
  }, 60_000);
});
