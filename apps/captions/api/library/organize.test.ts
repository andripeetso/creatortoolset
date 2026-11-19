import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

// A library's first-run choice (organize.ts): Default folders makes no folder; Smart folders ("ai") makes none up front
// and files what comes in, making a folder with its first file: a video or a camera photo into its shoot (shoots.ts),
// a sound by its kind, a graphic into Graphics. Through the PATCH route and the worker, with the AI stubbed.

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
const { fileInto, organizeOnProbe } = await import("./organize");
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

// tick() can claim nothing and never yield (it returns false while a device job is out), so wait a turn and bound the wait
const untilProbed = async (v: string) => {
  for (let turns = 0; job(v, "probe")?.state === "queued"; turns++) {
    if (turns > 5000) throw new Error(`probe of  still queued after 5000 turns`);
    await tick();
    await new Promise((r) => setImmediate(r));
  }
};

const probed = async (lib: string, id: string, kind: string, file: string) => {
  const v = await seed(lib, id, kind, file);
  enqueueJob(libraryDb(), lib, v, "probe", "local");
  await untilProbed(v);
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
  it("AI organizes: no folder up front, describe is not forced on; what is already there is filed", async () => {
    const d = libraryDb();
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.describe', json('false')) WHERE id = 'lib_ai'`).run();
    // a described video and a picture from before the choice, in no folder
    const old = await seed("lib_ai", "vid-old", "video", media("clip.mp4"), JSON.stringify({ duration: 2, vcodec: "h264" }));
    const pic = await seed("lib_ai", "pic-old", "image", media("still.jpg"), JSON.stringify({ duration: 0 }));
    d.prepare("UPDATE asset_versions SET state = 'ready' WHERE id IN (?, ?)").run(old, pic);
    enqueueJob(d, "lib_ai", old, "describe", "local");
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ?").run(old);
    const r = await organize("lib_ai", { organize: "ai" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { settings: unknown }).settings).toMatchObject({ organize: "ai", describe: false });
    await vi.waitFor(() => expect(folderOf("pic-old")).toEqual(["Graphics"])); // filed after the rule check, which runs in the background
    // the video into its shoot, with no AI call: never described again for a folder
    expect(folderOf("vid-old")).toHaveLength(1);
    expect(folders("lib_ai").map((f) => f.name).sort()).toEqual(["Graphics", folderOf("vid-old")[0]!].sort()); // made with their first file, nothing empty
    expect(job(old, "describe")?.state).toBe("done");
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(old);
    d.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'vid-old'").run();
    await organize("lib_ai", { organize: "ai" }); // the same choice again files nothing again
    expect(job(old, "describe")).toBeUndefined();
    // replaced (CEO 11-19: organize offer dropped; Organization is chosen in setup step 4 and Library settings only): no organizeOffered
  });

  it("a video goes into its shoot when probed; its description is asked no folder, and the place it names names the shoot; never Finals", async () => {
    const d = libraryDb();
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES ('col_finals', 'lib_ai', NULL, 'Finals', 'manual', 9)").run();
    const at = Date.UTC(2025, 2, 3, 12, 0);
    const v = await seed("lib_ai", "vid-lisbon", "video", media("clip.mp4"), JSON.stringify({ duration: 2, vcodec: "h264", capturedAt: at, tz: 0, country: "PT" }));
    d.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(v);
    organizeOnProbe(d, v, null);
    expect(folderOf("vid-lisbon")).toEqual(["3 Mar 2025 · Portugal"]);
    vi.mocked(aiFor).mockReturnValue({ only: ["mac"] } as never);
    vi.mocked(completeVisionWithFallback).mockImplementationOnce(async (_s, user, _i, _c, parse) => {
      expect(user).not.toContain('"folder"');
      expect(user).toContain("place is the town");
      return { value: parse(JSON.stringify({ description: "A tram climbs a hill.", tags: ["tram"], roll: "b", place: "Lisbon", folder: "Trams" })), provider: "test" } as never;
    });
    enqueueJob(d, "lib_ai", v, "describe", "local");
    await tick();
    expect(job(v, "describe")?.state).toBe("done");
    expect(folderOf("vid-lisbon")).toEqual(["3 Mar 2025 · Lisbon"]);
    expect(folders("lib_ai").some((f) => f.name === "Trams")).toBe(false); // a topic is a tag, never a folder
    expect(folderOf("vid-lisbon")).not.toContain("Finals");
  });

  it("a video already in a folder (dropped in one) is not asked about or moved", async () => {
    const d = libraryDb();
    const v = await seed("lib_ai", "vid-kept", "video", media("clip.mp4"), JSON.stringify({ duration: 2, vcodec: "h264" }));
    const graphics = (d.prepare("SELECT id FROM collections WHERE library_id = 'lib_ai' AND name = 'Graphics'").get() as { id: string }).id;
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES (?, 'vid-kept', 1, 'local')").run(graphics);
    vi.mocked(completeVisionWithFallback).mockImplementationOnce(async (_s, user, _i, _c, parse) => {
      expect(user).not.toContain("folder");
      return { value: parse('{"description": "A mat.", "tags": [], "folder": "Gameplay"}'), provider: "test" } as never;
    });
    enqueueJob(d, "lib_ai", v, "describe", "local");
    await tick();
    expect(job(v, "describe")?.state).toBe("done");
    expect(folderOf("vid-kept")).toEqual(["Graphics"]);
  });

  it("a sound under 20 s is a sound effect, a longer one music; a picture goes to Graphics; Default folders make and file nothing", async () => {
    await probed("lib_ai", "snd-short", "audio", media("short.m4a"));
    await probed("lib_ai", "snd-long", "audio", media("long.m4a"));
    await probed("lib_ai", "pic", "image", media("still.jpg"));
    expect([folderOf("snd-short"), folderOf("snd-long"), folderOf("pic")]).toEqual([["Sound effects"], ["Music"], ["Graphics"]]);
    expect(libraryDb().prepare("SELECT tag, source FROM asset_tags WHERE asset_id = 'snd-short'").all()).toEqual([{ tag: "sound effect", source: "ai" }]);

    await organize("lib_def", { organize: "default" });
    expect(folders("lib_def")).toHaveLength(0); // Default folders make no folder up front (UNIFIED-PRD §4.9)
    await probed("lib_def", "snd-def", "audio", media("short.m4a"));
    expect(folderOf("snd-def")).toEqual([]);
    // filed in no folder, a sound is still known as one (sound-kind.ts)
    expect(libraryDb().prepare("SELECT tag, source FROM asset_tags WHERE asset_id = 'snd-def'").all()).toEqual([{ tag: "sound effect", source: "ai" }]);
  });
});

describe("organize: kind folders", () => {
  it("fileInto makes the folder with its first file, the same one again in any case, never Finals", async () => {
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_aim', 'local', 'Aim', 'local', 0)").run();
    await seed("lib_aim", "aim", "video", media("clip.mp4"), JSON.stringify({ duration: 2 }));
    const a = { id: "aim", library_id: "lib_aim", kind: "video", created_by: "local" };
    const d = libraryDb();
    expect(fileInto(d, a, "Graphics")).toBe(true);
    expect(fileInto(d, a, "graphics")).toBe(true);
    expect(folders("lib_aim")).toEqual([{ name: "Graphics", kind: "manual", query: null }]);
    expect(d.prepare("SELECT rule FROM collections WHERE library_id = 'lib_aim'").get()).toEqual({ rule: null }); // never a self-filling folder
    expect(fileInto(d, a, "Finals")).toBe(false);
  });
});
