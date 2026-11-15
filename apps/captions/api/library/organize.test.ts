import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

// A library's first-run choice (organize.ts): Default folders and AI organizes make the six folders, AI organizes files
// what comes in: a video by its description's answer, a sound by its length, a picture into Graphics. Through the PATCH
// route and the worker, with the AI stubbed.

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-organize-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET; // the solo install: "local" is the admin
delete process.env.ANTHROPIC_API_KEY;
const { blobs, libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { enqueueJob } = await import("./jobs");
const { tick } = await import("./worker");
const { aiFor } = await import("../ai-complete");
const { completeVisionWithFallback } = await import("../ai-vision");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "local", role: "admin" } as never);
  return next();
});
app.route("/api/library", libraryApp);
const organize = (lib: string, settings: Record<string, unknown>) =>
  app.request(`/api/library/${lib}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) });

const media = (name: string) => path.join(dir, name);
const folders = (lib: string) =>
  libraryDb().prepare("SELECT name, kind, query FROM collections WHERE library_id = ? ORDER BY created_at, id").all(lib) as { name: string; kind: string; query: string | null }[];
const folderOf = (asset: string) =>
  (libraryDb().prepare("SELECT c.name FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = ?").all(asset) as { name: string }[]).map((r) => r.name);
const job = (v: string, kind: string) => libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = ?").get(v, kind) as { state: string } | undefined;

/** An asset of `kind` in `lib` with one version whose source is `file`. */
async function seed(lib: string, id: string, kind: string, file: string, probe?: string) {
  const d = libraryDb();
  const v = `ver-${id}`;
  const key = `libraries/${lib}/v/${v}/source`;
  const copy = media(`copy-${id}`); // put moves the file in
  copyFileSync(file, copy);
  await blobs.put(key, copy);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'local', 1)").run(id, lib, kind, `Tiny Acrobatics ${id}`, v);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'processing', 'local', 1)`,
  ).run(v, id, key, `sha-${id}`, probe ?? null);
  return v;
}

const probed = async (lib: string, id: string, kind: string, file: string) => {
  const v = await seed(lib, id, kind, file);
  enqueueJob(libraryDb(), lib, v, "probe", "local");
  while (job(v, "probe")?.state === "queued") await tick();
  return v;
};

beforeAll(() => {
  const ff = (...args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  ff("-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", media("clip.mp4"));
  ff("-f", "lavfi", "-i", "sine=duration=2", media("short.m4a"));
  ff("-f", "lavfi", "-i", "sine=duration=25", media("long.m4a"));
  ff("-f", "lavfi", "-i", "testsrc=size=160x120", "-frames:v", "1", media("still.jpg"));
  const add = libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, 'local', ?, 'local', 0)");
  add.run("lib_ai", "AI");
  add.run("lib_def", "Default");
});

describe("organize", () => {
  it("AI organizes: the six folders once, the descriptions on; a folder deleted later comes back only with the next choice", async () => {
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.describe', json('false')) WHERE id = 'lib_ai'`).run();
    const r = await organize("lib_ai", { organize: "ai" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { settings: unknown }).settings).toMatchObject({ organize: "ai", describe: true });
    await organize("lib_ai", { organize: "ai" });
    expect(folders("lib_ai")).toEqual([
      { name: "A-roll", kind: "smart", query: '{"roll":"a"}' }, // the AI Editor's A-roll folder (editor/ingest.ts) is this one
      { name: "B-roll", kind: "smart", query: '{"roll":"b"}' },
      { name: "Music", kind: "manual", query: null },
      { name: "Sound effects", kind: "manual", query: null },
      { name: "Graphics", kind: "manual", query: null },
      { name: "Examples", kind: "manual", query: null },
    ]);
    expect(((await (await organize("lib_ai", { organizeOffered: true })).json()) as { settings: unknown }).settings).toMatchObject({ organizeOffered: true });
  });

  it("a video is filed in the folder its description names, if it is one of the library's own; never in Finals", async () => {
    const d = libraryDb();
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES ('col_finals', 'lib_ai', NULL, 'Finals', 'manual', 9)").run();
    const answer = (folder: string) => {
      vi.mocked(aiFor).mockReturnValue({ only: ["mac"] } as never);
      vi.mocked(completeVisionWithFallback).mockImplementationOnce(async (_s, user, _i, _c, parse) => {
        expect(user).toContain('["Music","Sound effects","Graphics","Examples"]');
        return { value: parse(JSON.stringify({ description: "A person waves at the camera.", tags: [], roll: "b", folder })), provider: "test" } as never;
      });
    };
    for (const [id, folder] of [["vid-ex", "Examples"], ["vid-finals", "Finals"], ["vid-none", "Holidays"]] as const) {
      const v = await seed("lib_ai", id, "video", media("clip.mp4"), JSON.stringify({ duration: 2, vcodec: "h264" }));
      answer(folder);
      enqueueJob(d, "lib_ai", v, "describe", "local");
      await tick();
      expect(job(v, "describe")?.state).toBe("done");
    }
    expect(folderOf("vid-ex")).toEqual(["Examples"]);
    expect(folderOf("vid-finals")).toEqual([]);
    expect(folderOf("vid-none")).toEqual([]);
  });

  it("a video already in a folder (dropped in one) is not asked about or moved", async () => {
    const d = libraryDb();
    const v = await seed("lib_ai", "vid-kept", "video", media("clip.mp4"), JSON.stringify({ duration: 2, vcodec: "h264" }));
    const graphics = (d.prepare("SELECT id FROM collections WHERE library_id = 'lib_ai' AND name = 'Graphics'").get() as { id: string }).id;
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES (?, 'vid-kept', 1, 'local')").run(graphics);
    vi.mocked(completeVisionWithFallback).mockImplementationOnce(async (_s, user, _i, _c, parse) => {
      expect(user).not.toContain("folder");
      return { value: parse('{"description": "A mat.", "tags": [], "folder": "Examples"}'), provider: "test" } as never;
    });
    enqueueJob(d, "lib_ai", v, "describe", "local");
    await tick();
    expect(job(v, "describe")?.state).toBe("done");
    expect(folderOf("vid-kept")).toEqual(["Graphics"]);
  });

  it("a sound under 20 s is a sound effect, a longer one music; a picture goes to Graphics; Default folders files nothing", async () => {
    await probed("lib_ai", "snd-short", "audio", media("short.m4a"));
    await probed("lib_ai", "snd-long", "audio", media("long.m4a"));
    await probed("lib_ai", "pic", "image", media("still.jpg"));
    expect([folderOf("snd-short"), folderOf("snd-long"), folderOf("pic")]).toEqual([["Sound effects"], ["Music"], ["Graphics"]]);
    expect(libraryDb().prepare("SELECT tag, source FROM asset_tags WHERE asset_id = 'snd-short'").all()).toEqual([{ tag: "sound effect", source: "ai" }]);

    await organize("lib_def", { organize: "default" });
    expect(folders("lib_def")).toHaveLength(6);
    await probed("lib_def", "snd-def", "audio", media("short.m4a"));
    expect(folderOf("snd-def")).toEqual([]);
  });
});
