import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-analyze-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-analyze-test-secret";

const { blobs, libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { askVersionIn, saveTranscript } = await import("../library/transcribe");
const { createEdit, readStep } = await import("./store");
const { ENERGY_PER_SECOND, energyFile, readEnergy, sentencesOf } = await import("./analyze");
const { tick } = await import("./worker");
const { makeProxy } = await import("../library/media/proxy");
const { deviceStatus, LISTENING, transcribeOnDevice } = await import("../lib/device-transcribe");

const wav = path.join(dir, "tone.wav");
const word = (w: string, s: number, e: number) => ({ w, s, e });

/** A source version: the tone fixture, with this probe (null = not probed yet). */
async function seed(id: string, title: string, probe: object | null) {
  const key = `libraries/lib_a/v/${id}/source`;
  const file = path.join(dir, `src-${id}.wav`);
  copyFileSync(wav, file);
  await blobs.put(key, file);
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'mem-a', 0)").run(`a-${id}`, title);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, ?, 'mem-a', 0)").run(
    id,
    `a-${id}`,
    key,
    `sha-${id}`,
    probe ? JSON.stringify(probe) : null,
    probe ? "ready" : "processing",
  );
}

/** Queues analyze for a new edit of `sources` and runs one step at `now`; returns the edit id and its analyze job. */
async function analyze(sources: string[], now: number, extra: Record<string, unknown> = {}) {
  const e = (await createEdit("mem-a", { sources, ...extra }))!;
  enqueueJob(libraryDb(), "mem-a", `${e.id}:`, "analyze", "mem-a", true, "edit_jobs");
  await tick(now);
  return { id: e.id, job: () => libraryDb().prepare("SELECT state, error, attempts, run_after FROM edit_jobs WHERE edit_id = ? AND kind = 'analyze'").get(e.id) as Record<string, unknown> };
}
const transcribeJob = (v: string) => libraryDb().prepare("SELECT state, actor FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(v) as { state: string; actor: string } | undefined;

beforeAll(async () => {
  // tone 0-1 s, silence 1-2 s, tone 2-3 s: "speech" with one pause; a .wav so no encoder delay moves the edges; 48 kHz as a camera records (at 8 kHz an AAC proxy pads its end by up to 128 ms)
  execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,1\\,2)\\,0\\,0.5*sin(2*PI*440*t)):s=48000:d=3", "-y", wav]);
  libraryDb().exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0)");
  const p = { duration: 3, width: 0, height: 0, fps: 30, rotation: 0, format: "wav", vcodec: "", pixFmt: "", acodec: "pcm_s16le" };
  await seed("ver_late", "Take B", { ...p, capturedAt: 2000 });
  await seed("ver_early", "Take A", { ...p, capturedAt: 1000 });
  await seed("ver_mute", "Silent clip", { ...p, acodec: "" });
  await seed("ver_new", "Uploading", null);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor analyze", () => {
  it("splits words into sentences at a pause of 0.7 s or a full stop, numbered on from `first`", () => {
    const words = [word("so", 0, 0.2), word("this", 0.25, 0.4), word("is", 0.45, 0.5), word("it.", 0.55, 0.8), word("and", 0.9, 1), word("then", 1.75, 2), word("more", 2.1, 2.3)];
    expect(sentencesOf(words, "v", 5)).toEqual([
      { n: 5, src: "v", text: "so this is it.", s: 0, e: 0.8, w0: 0, w1: 3 },
      { n: 6, src: "v", text: "and", s: 0.9, e: 1, w0: 4, w1: 4 },
      { n: 7, src: "v", text: "then more", s: 1.75, e: 2.3, w0: 5, w1: 6 },
    ]);
  });

  it("reads silence where the tone stops and starts again, to within a frame", async () => {
    const e = await readEnergy(wav);
    expect(e.length).toBe(3 * ENERGY_PER_SECOND);
    const quietFrom = e.findIndex((x) => x < 0.01);
    const loudAgain = e.findIndex((x, i) => i > quietFrom && x > 0.01);
    const frame = ENERGY_PER_SECOND / 30;
    expect(Math.abs(quietFrom - 1 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
    expect(Math.abs(loudAgain - 2 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
    expect(e[50]).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it("a proxy's sound has its silences where the original's are, to within a frame", async () => {
    const proxy = path.join(dir, "tone-proxy.mp4");
    await makeProxy(wav, proxy, true);
    const e = await readEnergy(proxy);
    const frame = ENERGY_PER_SECOND / 30;
    expect(Math.abs(e.length - 3 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
    const quietFrom = e.findIndex((x) => x < 0.01);
    const loudAgain = e.findIndex((x, i) => i > quietFrom && x > 0.01);
    expect(Math.abs(quietFrom - 1 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
    expect(Math.abs(loudAgain - 2 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
  });

  it("a source with no words queues the library's transcribe as the creator and waits; one still uploading just waits", async () => {
    const now = Date.now();
    const { job } = await analyze(["ver_late", "ver_new"], now);
    expect(transcribeJob("ver_late")).toEqual({ state: "queued", actor: "mem-a" });
    expect(transcribeJob("ver_new")).toBeUndefined();
    expect(job()).toMatchObject({ state: "queued", attempts: 0, run_after: now + 30_000 });
  });

  it("a transcribe parked for the creator's missing key parks the edit with the same message", async () => {
    const why = "Add your Deepgram (or OpenAI) key in Settings → API keys";
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE version_id = 'ver_late' AND kind = 'transcribe'").run(why);
    const { job } = await analyze(["ver_late"], Date.now());
    expect(job()).toMatchObject({ state: "needs_key", error: why });
    // the creator adds a key: a retry queues the transcribe again and waits for it
    const { saveMyKey } = await import("../my-keys");
    saveMyKey("mem-a", "OPENAI_API_KEY", "sk-test");
    const again = await analyze(["ver_late"], Date.now());
    expect(transcribeJob("ver_late")).toEqual({ state: "queued", actor: "mem-a" });
    expect(again.job()).toMatchObject({ state: "queued" });
    saveMyKey("mem-a", "OPENAI_API_KEY", null);
  });

  it("on the person's own computer a transcribe parked for a missing key is queued again, and the step says what a running one is doing", async () => {
    const jobs = (state: string) => libraryDb().prepare("UPDATE jobs SET state = ?, error = NULL WHERE version_id = 'ver_late' AND kind = 'transcribe'").run(state);
    process.env.CT_LOCAL = "1";
    try {
      libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = 'Add a key' WHERE version_id = 'ver_late' AND kind = 'transcribe'").run();
      const first = await analyze(["ver_late"], Date.now());
      expect(transcribeJob("ver_late")).toEqual({ state: "queued", actor: "mem-a" });
      expect(first.job()).toMatchObject({ state: "queued", error: null });
      // the library's worker is on it: a stand-in model that listens until it is let go
      jobs("running");
      const samples = path.join(dir, "speech.f32");
      writeFileSync(samples, Buffer.from(new Float32Array(1600).buffer));
      let letGo!: () => void;
      const held = new Promise<void>((r) => (letGo = r));
      const model = Object.assign(async () => (await held, { chunks: [] }), { dispose: async () => {}, model: { generation_config: {} } });
      const run = transcribeOnDevice(samples, "ver_late", async () => model);
      await vi.waitFor(() => expect(deviceStatus("ver_late")).toBe(LISTENING));
      const { job } = await analyze(["ver_late"], Date.now());
      expect(job()).toMatchObject({ state: "queued", error: LISTENING });
      letGo();
      await run;
    } finally {
      delete process.env.CT_LOCAL;
      jobs("queued");
    }
  });

  it("numbers sentences across sources in recording order, caches each source's energy and notes a source with no sound", async () => {
    const d = libraryDb();
    saveTranscript(d, "ver_late", "deepgram", "en", [], [word("second", 0, 0.5), word("file.", 0.6, 0.9)]);
    saveTranscript(d, "ver_early", "deepgram", "en", [], [word("first", 0, 0.5), word("one", 2, 2.4)]);
    const { id, job } = await analyze(["ver_late", "ver_early", "ver_mute"], Date.now());
    expect(job()).toMatchObject({ state: "done" });
    const a = readStep(id, "analysis")!;
    expect(a.sentences.map((s) => [s.n, s.src, s.text])).toEqual([
      [1, "ver_early", "first"],
      [2, "ver_early", "one"],
      [3, "ver_late", "second file."],
    ]);
    expect(a.notes).toEqual(["“Silent clip” has no sound: left out"]);
    expect(existsSync(energyFile("ver_early")) && existsSync(energyFile("ver_late"))).toBe(true);
    // the step queues the script next
    expect(d.prepare("SELECT kind, state FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(id)).toEqual([
      { kind: "analyze", state: "done" },
      { kind: "script", state: "queued" },
    ]);
    d.prepare("DELETE FROM edit_jobs").run();
  });

  it("a source whose original is not on this server is read from its proxy", async () => {
    const d = libraryDb();
    const p = { duration: 3, width: 0, height: 0, fps: 30, rotation: 0, format: "wav", vcodec: "", pixFmt: "", acodec: "pcm_s16le" };
    await seed("ver_away", "On their computer", p);
    await blobs.delete("libraries/lib_a/v/ver_away/source");
    const proxy = path.join(dir, "away-proxy.wav");
    copyFileSync(wav, proxy);
    await blobs.put("libraries/lib_a/v/ver_away/proxy.mp4", proxy);
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('ver_away', 'proxy', 'libraries/lib_a/v/ver_away/proxy.mp4', 1)").run();
    saveTranscript(d, "ver_away", "deepgram", "en", [], [word("away", 0, 0.5)]);
    const { id, job } = await analyze(["ver_away"], Date.now());
    expect(job()).toMatchObject({ state: "done" });
    expect(readStep(id, "analysis")!.sentences.map((s) => s.text)).toEqual(["away"]);
    // the proxy's energy: the same tone, silent from 1 s to 2 s
    const e = await readEnergy(wav);
    const kept = readFileSync(energyFile("ver_away"));
    expect(new Float32Array(kept.buffer, kept.byteOffset, kept.byteLength / 4)).toEqual(e);
    d.prepare("DELETE FROM edit_jobs").run();
  });

  it("a take heard as silence is heard once more in the edit's own language; with none set, it goes on (planned, not refused) and says to pick one", async () => {
    const d = libraryDb();
    saveTranscript(d, "ver_early", "deepgram", "en", [], []);
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_early' AND kind = 'transcribe'").run();
    const plain = await analyze(["ver_early"], Date.now());
    expect(plain.job()).toMatchObject({ state: "done" });
    expect(readStep(plain.id, "analysis")).toMatchObject({ sentences: [], notes: [expect.stringMatching(/cut to the song or the brief\. If someone does speak in it, pick the language on the edit/)] });
    d.prepare("DELETE FROM edit_jobs").run();
    const { job } = await analyze(["ver_early"], Date.now(), { languages: ["et"] });
    expect(askVersionIn.get("ver_early")).toEqual({ by: "mem-a", languages: ["et"] });
    expect(transcribeJob("ver_early")).toEqual({ state: "queued", actor: "mem-a" });
    expect(job()).toMatchObject({ state: "queued" });
    // the next look, while that transcript is still to come: it waits, it does not fail on the old silence
    await tick(Date.now() + 60_000);
    expect(job()).toMatchObject({ state: "queued" });
    // if that re-transcribe parks for a missing key, analyze parks in needs_key instead of falling through to No speech found
    d.prepare("UPDATE jobs SET state = 'needs_key', error = 'Add your Deepgram (or OpenAI) key in Settings → API keys' WHERE version_id = 'ver_early' AND kind = 'transcribe'").run();
    await tick(Date.now() + 120_000);
    expect(job()).toMatchObject({ state: "needs_key", error: expect.stringMatching(/Deepgram|OpenAI/) });
    // if that re-transcribe failed, analyze fails with its error instead of falling through
    d.prepare("UPDATE jobs SET state = 'failed', error = 'bad audio' WHERE version_id = 'ver_early' AND kind = 'transcribe'").run();
    d.prepare("UPDATE edit_jobs SET state = 'queued', run_after = 0, attempts = 0, error = NULL").run();
    await tick(Date.now() + 180_000);
    expect(job()).toMatchObject({ state: "queued", error: expect.stringContaining("bad audio") });
    d.prepare("DELETE FROM edit_jobs").run();
  });

  it("a take transcribed in another language than the edit names is heard once more in that language even when it had words", async () => {
    const d = libraryDb();
    saveTranscript(d, "ver_early", "deepgram", "en", [], [word("wrong", 0, 0.4), word("words", 0.5, 0.9)]);
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_early' AND kind = 'transcribe'").run();
    const { job } = await analyze(["ver_early"], Date.now(), { languages: ["fi"] });
    expect(askVersionIn.get("ver_early")).toEqual({ by: "mem-a", languages: ["fi"] });
    expect(transcribeJob("ver_early")).toEqual({ state: "queued", actor: "mem-a" });
    expect(job()).toMatchObject({ state: "queued" });
    d.prepare("DELETE FROM edit_jobs").run();
  });

  it("the AI Editor row's own choice hears a clip made on another engine once more; on Same as default its transcript is used", async () => {
    const { writeVoicePrefs } = await import("../lib/speech");
    const { saveMyKey } = await import("../my-keys");
    const d = libraryDb();
    const done = () => d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_late' AND kind = 'transcribe'").run();
    saveTranscript(d, "ver_late", "deepgram", "en", [], [word("second", 0, 0.5), word("file.", 0.6, 0.9)]);
    done();
    saveMyKey("mem-a", "OPENAI_API_KEY", "sk-test");
    try {
      // the row on Same as default: the library's transcript as it is
      expect((await analyze(["ver_late"], Date.now())).job()).toMatchObject({ state: "done" });
      d.prepare("DELETE FROM edit_jobs").run();
      // the row on OpenAI: heard again by it as the edit's creator, and the edit waits for it
      writeVoicePrefs("mem-a", { stt: { per: { editor: { engine: "openai" } } } });
      const { job } = await analyze(["ver_late"], Date.now());
      expect(transcribeJob("ver_late")).toEqual({ state: "queued", actor: "mem-a" });
      expect(job()).toMatchObject({ state: "queued" });
      await tick(Date.now() + 60_000);
      expect(job()).toMatchObject({ state: "queued" });
      // made, on its library engine all the same (a fallback): once only, the edit goes on with it
      done();
      await tick(Date.now() + 120_000);
      expect(job()).toMatchObject({ state: "done" });
      expect(transcribeJob("ver_late")).toEqual({ state: "done", actor: "mem-a" });
    } finally {
      writeVoicePrefs("mem-a", { stt: { per: { editor: null } } });
      saveMyKey("mem-a", "OPENAI_API_KEY", null);
      d.prepare("DELETE FROM edit_jobs").run();
    }
  });

  it("matches OpenAI language names and BCP-47 tags without re-transcribing, and re-transcribes a clip marked B-roll in the wrong language", async () => {
    const d = libraryDb();
    saveTranscript(d, "ver_late", "openai", "finnish", [{ start: 0, end: 1, text: "hei" }], [word("hei", 0, 0.5)]);
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_late' AND kind = 'transcribe'").run();
    expect((await analyze(["ver_late"], Date.now(), { languages: ["fi"] })).job()).toMatchObject({ state: "done" });
    expect(transcribeJob("ver_late")?.state).toBe("done");
    d.prepare("DELETE FROM edit_jobs").run();

    saveTranscript(d, "ver_late", "deepgram", "en-US", [{ start: 0, end: 1, text: "hello" }], [word("hello", 0, 0.5)]);
    expect((await analyze(["ver_late"], Date.now(), { languages: ["en"] })).job()).toMatchObject({ state: "done" });
    expect(transcribeJob("ver_late")?.state).toBe("done");
    d.prepare("DELETE FROM edit_jobs").run();

    // clip sorted B-roll after an empty English transcript still re-transcribes once the edit asks for Finnish
    saveTranscript(d, "ver_early", "deepgram", "en", [], []);
    d.prepare("UPDATE assets SET roll = 'b' WHERE id = (SELECT asset_id FROM asset_versions WHERE id = 'ver_early')").run();
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_early' AND kind = 'transcribe'").run();
    try {
      const { job } = await analyze(["ver_early"], Date.now(), { languages: ["sv"] });
      expect(transcribeJob("ver_early")).toEqual({ state: "queued", actor: "mem-a" });
      expect(job()).toMatchObject({ state: "queued" });
    } finally {
      d.prepare("UPDATE assets SET roll = NULL WHERE id = (SELECT asset_id FROM asset_versions WHERE id = 'ver_early')").run();
      d.prepare("DELETE FROM edit_jobs").run();
    }
  });

  it("parks analyze as needs_key instead of looping when the user only has an English-only computer model for a non-English edit", async () => {
    const { pairDevice, revokeDevice, setDeviceKinds, setDeviceStt, touchDevice } = await import("../lib/devices");
    const { writeVoicePrefs } = await import("../lib/speech");
    const d = libraryDb();
    const { device } = pairDevice("mem-a", "Mac");
    setDeviceKinds(device.id, ["transcribe"]);
    setDeviceStt(device.id, { want: [], held: ["parakeet-tdt-0.6b-v3"], getting: [] });
    touchDevice(device.id);
    writeVoicePrefs("mem-a", { languages: ["en"] });
    d.prepare("DELETE FROM transcripts WHERE version_id = 'ver_early'").run();
    d.prepare("INSERT OR REPLACE INTO jobs (library_id, version_id, kind, state, actor, error) VALUES ('lib_a', 'ver_early', 'transcribe', 'needs_key', 'mem-a', 'Needs a speech model')").run();
    try {
      const { job } = await analyze(["ver_early"], Date.now(), { languages: ["fi"] });
      expect(job()).toMatchObject({ state: "needs_key" });
      expect(transcribeJob("ver_early")?.state).toBe("needs_key");
    } finally {
      await revokeDevice(device.id);
      writeVoicePrefs("mem-a", { languages: [] });
      d.prepare("DELETE FROM edit_jobs").run();
    }
  });
});
