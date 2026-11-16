import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-worker-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { claimJob, enqueueJob, finishJob, prepareFirst, takingClips } = await import("./jobs");
const { LANES, nextJob, tick } = await import("./worker");
const { blobs } = await import("./db");
const { ffmpegSlot } = await import("./media/run");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const d = libraryDb();
for (const lib of ["lib_a", "lib_b"]) d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'local', 'L', 'local', '{}', 1)`).run(lib);
const lane = (name: string) => LANES.find((l) => l.name === name)!.kinds;
/** What a lane runs next, as "version kind", and runs it (done at once). */
const next = (name: string, now = Date.now()) => {
  const id = nextJob(d, now, lane(name));
  if (id === null) return null;
  const job = claimJob(d, 300, now, "jobs", lane(name), id)!;
  finishJob(d, job.id, true);
  return `${job.version_id} ${job.kind}`;
};

beforeEach(() => {
  d.prepare("DELETE FROM jobs").run();
  takingClips.clear();
});

// a transcript whose speech model is not downloaded yet: the stand-in for transcribeVersion says so (lib/device-transcribe.ts)
import { vi } from "vitest";
const stuck = vi.hoisted(() => ({ model: false }));
// a probe's answer, set by a test (the files here are not media): null = the real ffprobe
const probed = vi.hoisted(() => ({ value: null as import("./media/probe").ProbeSummary | null }));
vi.mock("./media/probe", async (real) => {
  const m = await real<typeof import("./media/probe")>();
  return { ...m, probe: (f: string) => (probed.value ? Promise.resolve(probed.value) : m.probe(f)) };
});
// the files a transcript was made from, when a test asks (`heard.on`): then nothing is transcribed
const heard = vi.hoisted(() => ({ on: false, files: [] as string[] }));
vi.mock("./transcribe", async (real) => {
  const m = await real<typeof import("./transcribe")>();
  const { ModelNotReady } = await import("../lib/device-transcribe");
  return {
    ...m,
    transcribeVersion: (...a: Parameters<typeof m.transcribeVersion>) =>
      heard.on ? (async () => void heard.files.push(typeof a[2] === "string" ? a[2] : await a[2]()))() : stuck.model ? Promise.reject(new ModelNotReady("not downloaded")) : m.transcribeVersion(...a),
  };
});

describe("a transcript of a clip with a proxy", () => {
  it("is made from its proxy's sound, as every reader that only measures a clip, also when the original is here", async () => {
    const { tick: run } = await import("./worker");
    const { blobs: store } = await import("./db");
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    const put = async (key: string, text: string) => {
      const f = path.join(dir, `${text}.bin`);
      write(f, text);
      await store.put(key, f);
    };
    for (const id of ["v_px", "v_or"]) {
      d.prepare(`INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)`).run(`a_${id}`, id, id);
      d.prepare(
        `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
         VALUES (?, ?, 1, ?, 1, ?, '{"duration":5,"vcodec":"h264","acodec":"aac"}', 'ready', 'local', 1)`,
      ).run(id, `a_${id}`, `k/${id}`, id);
      await put(`k/${id}-proxy.mp4`, `${id} proxy`);
      d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 1)").run(id, `k/${id}-proxy.mp4`);
    }
    await put("k/v_or", "v_or original"); // v_px's original was never put here: it stays on the user's computer
    heard.on = true;
    try {
      for (const id of ["v_px", "v_or"]) {
        enqueueJob(d, "lib_a", id, "transcribe", "local");
        expect(await run(Date.now(), LANES.find((l) => l.name === "transcripts")!.kinds)).toBe(true);
      }
      expect(heard.files.map((f) => readFileSync(f, "utf-8"))).toEqual(["v_px proxy", "v_or proxy"]);
      expect(d.prepare("SELECT version_id, state FROM jobs WHERE kind = 'transcribe' ORDER BY version_id").all()).toEqual([
        { version_id: "v_or", state: "done" },
        { version_id: "v_px", state: "done" },
      ]);
    } finally {
      heard.on = false;
    }
  });
});

describe("a transcript whose speech model did not download", () => {
  it("waits a minute and tries again, saying why, without spending an attempt or failing its clip", async () => {
    // its own imports: it is picked onto other branches by itself
    const { MODEL_WAITS, tick: run } = await import("./worker");
    const { blobs: store } = await import("./db");
    const { writeFileSync: write } = await import("node:fs");
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_m', 'lib_a', 'video', 'm', 'v_m', 'local', 1)").run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
       VALUES ('v_m', 'a_m', 1, 'k/v_m', 1, 'v_m', '{"duration":5,"vcodec":"h264","acodec":"aac"}', 'processing', 'local', 1)`,
    ).run();
    const f = path.join(dir, "v_m.bin");
    write(f, "sound");
    await store.put("k/v_m", f);
    enqueueJob(d, "lib_a", "v_m", "transcribe", "local");
    stuck.model = true;
    try {
      const before = Date.now();
      expect(await run(before, LANES.find((l) => l.name === "transcripts")!.kinds)).toBe(true);
      const j = d.prepare("SELECT state, attempts, run_after, error FROM jobs WHERE version_id = 'v_m'").get() as { state: string; attempts: number; run_after: number; error: string };
      expect(j).toMatchObject({ state: "queued", attempts: 0, error: MODEL_WAITS });
      expect(j.run_after).toBeGreaterThanOrEqual(before + 60_000);
      expect(d.prepare("SELECT state FROM asset_versions WHERE id = 'v_m'").get()).toEqual({ state: "processing" });
    } finally {
      stuck.model = false;
    }
  });
});

describe("the order clips are prepared in", () => {
  it("every clip's picture first, then the slow steps; in a lane, all lighter copies before the duplicate checks", () => {
    // v1 came in and was probed, v2 and v3 came in after: their probes and v1's picture are still to do
    for (const k of ["proxy", "fingerprint", "transcribe", "thumb"]) enqueueJob(d, "lib_a", "v1", k, "local");
    enqueueJob(d, "lib_a", "v2", "probe", "local");
    enqueueJob(d, "lib_a", "v3", "probe", "local");
    expect(nextJob(d, Date.now(), lane("transcripts"))).toBeNull(); // no transcript while a picture can run
    expect([next("pictures"), next("pictures"), next("pictures")]).toEqual(["v2 probe", "v3 probe", "v1 thumb"]);
    for (const v of ["v2", "v3"]) for (const k of ["proxy", "fingerprint"]) enqueueJob(d, "lib_a", v, k, "local");
    expect(next("transcripts")).toBe("v1 transcribe");
    expect([1, 2, 3, 4, 5, 6].map(() => next("files"))).toEqual(["v1 proxy", "v2 proxy", "v3 proxy", "v1 fingerprint", "v2 fingerprint", "v3 fingerprint"]);
  });

  it("a video's strip of frames after every picture and lighter copy, before the duplicate checks", () => {
    for (const v of ["v1", "v2"]) for (const k of ["fingerprint", "sprite", "proxy"]) enqueueJob(d, "lib_a", v, k, "local");
    enqueueJob(d, "lib_a", "v3", "thumb", "local");
    expect(next("files")).toBeNull(); // the library's picture first
    expect(next("pictures")).toBe("v3 thumb");
    expect([1, 2, 3, 4, 5].map(() => next("files"))).toEqual(["v1 proxy", "v2 proxy", "v1 sprite", "v2 sprite", "v1 fingerprint"]);
  });

  it("slow steps wait while the library's folders hand clips over, and a picture waiting for its retry holds nothing back", () => {
    enqueueJob(d, "lib_a", "v1", "proxy", "local");
    takingClips.add("lib_a");
    expect(next("files")).toBeNull();
    takingClips.delete("lib_a");
    enqueueJob(d, "lib_a", "v2", "thumb", "local");
    d.prepare("UPDATE jobs SET run_after = ? WHERE kind = 'thumb'").run(Date.now() + 60_000); // failed once, tries again in a minute
    expect(next("files")).toBe("v1 proxy");
  });

  it("one library's pictures hold back only its own slow steps", () => {
    enqueueJob(d, "lib_a", "a1", "thumb", "local");
    enqueueJob(d, "lib_b", "b1", "transcribe", "local");
    enqueueJob(d, "lib_a", "a2", "transcribe", "local");
    expect(next("transcripts")).toBe("b1 transcribe");
    expect(next("transcripts")).toBeNull();
  });

  it("a clip the person opens: its picture before the other pictures, its slow steps only after every picture", () => {
    for (const v of ["v1", "v2"]) enqueueJob(d, "lib_a", v, "proxy", "local");
    for (const v of ["v3", "v4"]) enqueueJob(d, "lib_a", v, "thumb", "local");
    enqueueJob(d, "lib_a", "v2", "wave", "local");
    enqueueJob(d, "lib_a", "v2", "transcribe", "local");
    prepareFirst("v2");
    expect(next("transcripts")).toBeNull(); // its transcript waits for the pictures like any other
    expect([1, 2, 3].map(() => next("pictures"))).toEqual(["v2 wave", "v3 thumb", "v4 thumb"]);
    expect([1, 2].map(() => next("files"))).toEqual(["v2 proxy", "v1 proxy"]);
    expect(next("transcripts")).toBe("v2 transcribe");
  });

  it("a description waits, unclaimed, while its clip's transcript is to come", () => {
    enqueueJob(d, "lib_a", "v1", "transcribe", "local");
    enqueueJob(d, "lib_a", "v1", "describe", "local");
    expect(next("ai")).toBeNull();
    next("transcripts");
    expect(next("ai")).toBe("v1 describe");
  });
});

describe("a step is running only while it really runs", () => {
  /** A clip with a sound track whose source blob is there (its bytes are not a real video: ffmpeg fails on them). */
  const clip = async (v: string) => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)").run(`a_${v}`, v, v);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
       VALUES (?, ?, 1, ?, 1, ?, '{"duration":5,"vcodec":"h264","acodec":"aac"}', 'processing', 'local', 1)`,
    ).run(v, `a_${v}`, `k/${v}`, v);
    const f = path.join(dir, `${v}.bin`);
    writeFileSync(f, "not a video");
    await blobs.put(`k/${v}`, f);
    enqueueJob(d, "lib_a", v, "transcribe", "local");
  };
  const running = () => (d.prepare("SELECT version_id AS v FROM jobs WHERE state = 'running' ORDER BY version_id").all() as { v: string }[]).map((r) => r.v);

  it("this computer claims one search entry at a time too", async () => {
    process.env.CT_LOCAL = "1";
    delete process.env.OPENAI_API_KEY;
    const net = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError("no network in tests"))) as typeof fetch; // the search model is never fetched here
    let free!: () => void;
    const held = ffmpegSlot(() => new Promise<void>((r) => (free = r))); // the line every heavy job runs in is busy
    try {
      for (const v of ["e1", "e2"]) {
        d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)").run(
          `a_${v}`,
          `Tiny Acrobatics handstand on the beach at sunset ${v}`,
          v,
        );
        d.prepare(
          `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
           VALUES (?, ?, 1, ?, 1, ?, '{"duration":5,"vcodec":"h264"}', 'ready', 'local', 1)`,
        ).run(v, `a_${v}`, `k/${v}`, v);
        enqueueJob(d, "lib_a", v, "embed", "local");
      }
      const lane = LANES.find((l) => l.name === "ai")!.kinds;
      const ticks = [tick(Date.now(), lane), tick(Date.now(), lane)];
      expect(await Promise.race([ticks[1], new Promise((r) => setTimeout(() => r("waiting"), 300))])).toBe(false);
      expect(running()).toEqual(["e1"]);
      free();
      await Promise.all([...ticks, held]);
    } finally {
      free?.();
      globalThis.fetch = net;
      delete process.env.CT_LOCAL;
    }
  });

  it("this computer claims one transcript at a time; a key's service takes several at once", async () => {
    process.env.CT_LOCAL = "1";
    let free!: () => void;
    const held = ffmpegSlot(() => new Promise<void>((r) => (free = r))); // a picture holds ffmpeg: the transcripts wait inside their run
    try {
      for (const v of ["t1", "t2", "t3"]) await clip(v);
      const lane = LANES.find((l) => l.name === "transcripts")!.kinds;
      const onDevice = [tick(Date.now(), lane), tick(Date.now(), lane), tick(Date.now(), lane)];
      expect(await Promise.race([Promise.all(onDevice.slice(1)), new Promise((r) => setTimeout(() => r("waiting"), 500))])).toEqual([false, false]);
      expect(running()).toEqual(["t1"]); // the other two wait, queued: their cards say nothing yet
      process.env.DEEPGRAM_API_KEY = "test-key";
      const onKey = [tick(Date.now(), lane), tick(Date.now(), lane)];
      await new Promise((r) => setTimeout(r, 50));
      expect(running()).toEqual(["t1", "t2", "t3"]);
      free();
      await Promise.all([...onDevice, ...onKey, held]);
    } finally {
      free?.();
      delete process.env.CT_LOCAL;
      delete process.env.DEEPGRAM_API_KEY;
    }
  });
});

describe("strips of frames", () => {
  const add = (id: string, kind: string, opts: { state?: string; trashed?: boolean; created?: number } = {}) => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, trashed_at) VALUES (?, 'lib_a', ?, ?, ?, 'local', ?, ?)").run(
      `a_${id}`, kind, id, id, opts.created ?? 1, opts.trashed ? 2 : null,
    );
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
       VALUES (?, ?, 1, ?, 1, ?, '{"duration":5,"vcodec":"h264","acodec":"aac"}', ?, 'local', 1)`,
    ).run(id, `a_${id}`, `k/${id}`, id, opts.state ?? "ready");
  };

  it("a probe queues one for a video, never for a photo (probed as a one-frame video)", async () => {
    probed.value = { duration: 5, width: 320, height: 240, fps: 25, rotation: 0, format: "mov,mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
    try {
      for (const [id, kind] of [["pv", "video"], ["pi", "image"]] as const) {
        add(id, kind, { state: "processing" });
        const f = path.join(dir, `${id}.bin`);
        writeFileSync(f, id);
        await blobs.put(`k/${id}`, f);
        enqueueJob(d, "lib_a", id, "probe", "local");
        expect(await tick(Date.now(), ["probe"])).toBe(true);
      }
      const kinds = (v: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(v) as { kind: string }[]).map((r) => r.kind);
      expect(kinds("pv")).toContain("sprite");
      expect(kinds("pi")).not.toContain("sprite");
    } finally {
      probed.value = null;
    }
  });

  it("a photo gets no proxy or fingerprint, though its probe reads as a video the browser can't play", async () => {
    probed.value = { duration: 0.04, width: 3000, height: 4000, fps: 25, rotation: 0, format: "image2", vcodec: "mjpeg", pixFmt: "yuvj420p", acodec: "" };
    try {
      for (const [id, kind] of [["xv", "video"], ["xi", "image"]] as const) {
        add(id, kind, { state: "processing" });
        const f = path.join(dir, `${id}.bin`);
        writeFileSync(f, id);
        await blobs.put(`k/${id}`, f);
        enqueueJob(d, "lib_a", id, "probe", "local");
        expect(await tick(Date.now(), ["probe"])).toBe(true);
      }
      const kinds = (v: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(v) as { kind: string }[]).map((r) => r.kind);
      expect(kinds("xv")).toContain("proxy");
      expect(kinds("xi")).not.toContain("proxy");
      expect(kinds("xv")).toContain("fingerprint");
      expect(kinds("xi")).not.toContain("fingerprint");
    } finally {
      probed.value = null;
    }
  });

  it("an older video gets one once, newest first, outside the queue; photos, music, trash and failed clips are left alone", async () => {
    const { backfillSprite } = await import("./worker");
    // only these have a duplicate check (the jobs are cleared before each test): the other tests' clips are not candidates
    add("old", "video", { created: 1 });
    add("new", "video", { created: 5 });
    add("photo", "image");
    add("song", "video"); // from a music folder: never checked for duplicates
    add("binned", "video", { trashed: true });
    add("broken", "video", { state: "failed" });
    for (const v of ["old", "new", "photo", "binned", "broken"]) d.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib_a', ?, 'fingerprint', 'done')").run(v);
    const sprite = () => d.prepare("SELECT version_id, state, error FROM jobs WHERE kind = 'sprite' ORDER BY id").all() as { version_id: string; state: string; error: string }[];
    // their files are not video here: each try fails, and is kept so it is not tried again
    expect(await backfillSprite()).toBe(true);
    expect(sprite().map((j) => [j.version_id, j.state])).toEqual([["new", "failed"]]);
    expect(nextJob(d, Date.now(), lane("files"))).toBeNull(); // nothing queued: nothing counts as preparing
    expect(await backfillSprite()).toBe(true);
    expect(await backfillSprite()).toBe(false);
    expect(sprite().map((j) => j.version_id)).toEqual(["new", "old"]);
    expect(sprite()[0]!.error).toBeTruthy();
    expect(d.prepare("SELECT state FROM asset_versions WHERE id = 'old'").get()).toEqual({ state: "ready" }); // an extra: the clip stays ready
  });
});
