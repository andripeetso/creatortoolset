import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-search-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin
delete process.env.DEEPGRAM_API_KEY;
delete process.env.OPENAI_API_KEY;
const { blobs, libraryDb } = await import("./db");
const { searchApp } = await import("./search");
const { indexAsset } = await import("./query");
const { saveTranscript, segmentsOf, transcribeRoute, transcribeVersion, wordsToSegments, NeedsKey } = await import("./transcribe");
const { enqueueJob } = await import("./jobs");
const { tick } = await import("./worker");
const { clipContext, libraryRef, transcriptExcerpt } = await import("./attach");
const { ensureProjectOriginal } = await import("../media-store");

afterAll(() => {
  delete process.env.DEEPGRAM_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", searchApp);
const get = (user: string, url: string) => app.request(url, { headers: { "x-user": user } });

/** An asset with one ready version whose source is `bytes`. */
async function seed(id: string, title: string, bytes = "tiny acrobatics clip") {
  const d = libraryDb();
  const v = `ver-${id}`;
  const file = path.join(dir, `src-${id}`);
  writeFileSync(file, bytes);
  const key = `libraries/lib_a/v/${v}/source`;
  await blobs.put(key, file);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)").run(id, title, v);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'ready', 'local', 1)`,
  ).run(v, id, key, bytes.length, `sha-${id}`, JSON.stringify({ duration: 30, vcodec: "h264", acodec: "aac" }));
  indexAsset(d, id);
  return v;
}

beforeAll(async () => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'local', 'A', 'local', 0)").run();
  const v = await seed("ast-roll-0001", "Forward roll practice");
  saveTranscript(libraryDb(), v, "deepgram", "en", [
    { start: 0, end: 4.2, text: "Today we practise the forward roll." },
    { start: 4.2, end: 9, text: "Tuck the chin before the mat." },
    { start: 12.5, end: 16, text: "A balance beam needs soft knees." },
  ]);
});

describe("search", () => {
  it("a line said in a clip comes back with the second it starts at", async () => {
    const hits = (await (await get("local", "/api/library/lib_a/search?q=balance%20beam")).json()) as any[];
    const said = hits.filter((h) => h.seconds !== undefined);
    expect(said).toHaveLength(1);
    expect(said[0].seconds).toBe(12.5);
    expect(said[0].asset.id).toBe("ast-roll-0001");
    expect(said[0].snippet).toContain("balance beam");
  });

  it("a title match is an asset hit, ahead of lines said", async () => {
    saveTranscript(libraryDb(), "ver-ast-roll-0001", "deepgram", "en", [
      { start: 0, end: 4.2, text: "Today we practise the forward roll." },
      { start: 12.5, end: 16, text: "A balance beam needs soft knees." },
    ]); // a re-run replaces the rows, never doubles them
    const hits = (await (await get("local", "/api/library/lib_a/search?q=roll")).json()) as any[];
    expect(hits[0]).toEqual({ asset: expect.objectContaining({ title: "Forward roll practice" }) });
    expect(hits.filter((h) => h.seconds !== undefined).map((h) => h.seconds)).toEqual([0]);
  });

  it("the transcript is absent for another account", async () => {
    expect((await get("other-b", "/api/library/lib_a/search?q=balance")).status).toBe(404);
    const outside = await get("other-b", "/api/library/lib_a/assets/ast-roll-0001");
    expect(outside.status).toBe(404);
    expect(await outside.text()).not.toContain("balance");
    const inside = (await (await get("local", "/api/library/lib_a/assets/ast-roll-0001")).json()) as any;
    expect(inside.transcript.segments[1]).toEqual({ start: 12.5, end: 16, text: "A balance beam needs soft knees." });
  });
});

describe("transcribe job", () => {
  const job = (v: string) => libraryDb().prepare("SELECT state, error FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(v) as { state: string; error: string };
  const versionState = (v: string) => (libraryDb().prepare("SELECT state FROM asset_versions WHERE id = ?").get(v) as { state: string }).state;

  it("no key → needs_key, not failed, and the version stays ready", async () => {
    const v = await seed("ast-nokey-01", "Bridge");
    enqueueJob(libraryDb(), "lib_a", v, "transcribe", "local");
    expect(await tick()).toBe(true);
    expect(job(v).state).toBe("needs_key");
    expect(job(v).error).toBe("Add your Deepgram (or OpenAI) key in Settings → My API keys");
    expect(versionState(v)).toBe("ready");
  });

  it("routes: the admin on the server's key, any other account needs its own", () => {
    process.env.DEEPGRAM_API_KEY = "test-key";
    expect(transcribeRoute("local")).toEqual({ provider: "deepgram", key: "test-key" });
    expect(() => transcribeRoute("other-b")).toThrow(NeedsKey);
    delete process.env.DEEPGRAM_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    expect(transcribeRoute("local")).toEqual({ provider: "openai", key: "test-key" });
    delete process.env.OPENAI_API_KEY;
  });

  it("a clip: the audio goes to the provider and the transcript is stored", async () => {
    const clip = path.join(dir, "fixture.mp4"); // one second, made here: nothing large is committed
    execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    const v = await seed("ast-handst-1", "Handstand");
    const sent: { url: string; type: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, type: new Headers(init.headers).get("content-type") });
      return url.includes("deepgram")
        ? Response.json({ results: { channels: [{ alternatives: [{ words: [{ word: "hold", punctuated_word: "Hold", start: 0.1, end: 0.4 }, { word: "it", punctuated_word: "it.", start: 0.4, end: 0.6 }] }] }] } })
        : Response.json({ language: "english", segments: [{ start: 0.2, end: 0.9, text: " Hold it." }] });
    });
    try {
      process.env.DEEPGRAM_API_KEY = "test-key";
      await transcribeVersion(libraryDb(), v, clip, "local", dir);
      expect(segmentsOf(libraryDb(), v)).toEqual([{ start: 0.1, end: 0.6, text: "Hold it." }]);
      expect(sent[0]).toEqual({ url: expect.stringContaining("api.deepgram.com"), type: "audio/wav" });
      delete process.env.DEEPGRAM_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      await transcribeVersion(libraryDb(), v, clip, "local", dir);
      expect(sent[1]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(segmentsOf(libraryDb(), v)).toEqual([{ start: 0.2, end: 0.9, text: "Hold it." }]);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.DEEPGRAM_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("words become one segment per utterance", () => {
    const w = (text: string, start: number, utterance?: number) => ({ text, start, end: start + 0.3, utterance });
    expect(wordsToSegments([w("Tuck", 1, 0), w("in.", 1.4, 0), w("Roll", 5, 1)])).toEqual([
      { start: 1, end: 1.7, text: "Tuck in." },
      { start: 5, end: 5.3, text: "Roll" },
    ]);
    // without utterances: a pause over a second starts a new one
    expect(wordsToSegments([w("Tuck", 1), w("in.", 1.4), w("Roll", 5)]).map((s) => s.text)).toEqual(["Tuck in.", "Roll"]);
  });
});

describe("Workshop attachment", () => {
  it("gives the AI the transcript excerpt and the title, never to an outsider", async () => {
    expect(await libraryRef("other-b", "ast-roll-0001", "ver-ast-roll-0001")).toBeNull();
    expect(await clipContext("other-b", { assetId: "ast-roll-0001", versionId: "ver-ast-roll-0001" })).toBeNull();
    expect(await libraryRef("local", "ast-roll-0001", "ver-ast-other")).toBeNull(); // not a version of this asset
    const clip = await clipContext("local", { assetId: "ast-roll-0001", versionId: "ver-ast-roll-0001" });
    expect(clip).toEqual({ title: "Forward roll practice", transcript: "[0:00] Today we practise the forward roll.\n[0:12] A balance beam needs soft knees." });
  });

  it("cuts a long transcript", () => {
    const segs = Array.from({ length: 200 }, (_, i) => ({ start: i * 3, text: "Soft knees on the beam, every landing." }));
    const out = transcriptExcerpt(segs, 500);
    expect(out.length).toBeLessThan(560);
    expect(out.endsWith("[… the transcript goes on]")).toBe(true);
  });
});

describe("Caption Studio link", () => {
  function project(id: string, owner: string, versionId: string) {
    mkdirSync(path.join(dir, "projects", id), { recursive: true });
    writeFileSync(
      path.join(dir, "projects", id, "meta.json"),
      JSON.stringify({ id, name: "Roll", createdAt: 0, updatedAt: 0, duration: 0, owner, clips: [{ id: "clip-000001", name: "Roll", duration: 30, createdAt: 0, libraryVersionId: versionId }] }),
    );
    return path.join(dir, "projects", id, "clips", "clip-000001", "original");
  }

  it("a clip from the library reads its original from the library again", async () => {
    const original = project("proj-000001", "local", "ver-ast-roll-0001");
    expect(await ensureProjectOriginal("proj-000001", "clip-000001", original)).toBe(original);
    expect(readFileSync(original, "utf-8")).toBe("tiny acrobatics clip");
  });

  it("not for a project owner who does not own the library", async () => {
    const original = project("proj-000002", "other-b", "ver-ast-roll-0001");
    expect(await ensureProjectOriginal("proj-000002", "clip-000001", original)).toBeNull();
  });
});

describe("Caption Studio from a clip: refused for a clip the caller can't see", () => {
  const opens = (user: string, assetId: string) => app.request(`/api/library/lib_a/assets/${assetId}/captions`, { method: "POST", headers: { "x-user": user } });

  it("an account outside the library gets a 404, not the clip", async () => {
    const r = await opens("other-b", "ast-roll-0001");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("projectId");
  });

  it("a trashed clip is a 404 even for the library's owner, and no project is opened", async () => {
    libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast-roll-0001'").run();
    try {
      const r = await opens("local", "ast-roll-0001");
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("projectId");
    } finally {
      libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast-roll-0001'").run();
    }
  });
});
