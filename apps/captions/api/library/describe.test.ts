import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-describe-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET; // the solo install: "local" is the admin
delete process.env.ANTHROPIC_API_KEY;
const { blobs, libraryDb } = await import("./db");
const { searchApp } = await import("./search");
const { indexAsset, buildAssetQuery, pageOf } = await import("./query");
const { enqueueJob } = await import("./jobs");
const { tick } = await import("./worker");
const { describePrompt, describeVersion, parseDescribe, saveDescribed, tagsOf, workspaceOf } = await import("./describe");
const { saveTranscript } = await import("./transcribe");
const { aiFor } = await import("../ai-complete");
const { completeVisionWithFallback } = await import("../ai-vision");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", searchApp);
const call = (user: string, url: string, method = "GET", body?: unknown) =>
  app.request(url, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const clip = path.join(dir, "fixture.mp4");
const withSound = path.join(dir, "fixture-sound.mp4");

/** An asset with one ready video version; its source is the fixture clip unless `bytes` is given. */
async function seed(id: string, by = "local", bytes?: string, from = clip) {
  const d = libraryDb();
  const v = `ver-${id}`;
  const file = path.join(dir, `src-${id}`);
  if (bytes) writeFileSync(file, bytes);
  else copyFileSync(from, file);
  const key = `libraries/lib_a/v/${v}/source`;
  await blobs.put(key, file);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, ?, 1)").run(id, `Clip ${id}`, v, by);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', ?, 1)`,
  ).run(v, id, key, `sha-${id}`, JSON.stringify({ duration: 2, vcodec: "h264" }), by);
  indexAsset(d, id);
  return v;
}

const job = (v: string, kind: string) =>
  libraryDb().prepare("SELECT state, error FROM jobs WHERE version_id = ? AND kind = ?").get(v, kind) as { state: string; error: string | null } | undefined;
const card = (assetId: string) => {
  const { sql, params, limit } = buildAssetQuery("lib_a");
  return pageOf(libraryDb().prepare(sql).all(...params) as never, limit).items.find((a) => a.id === assetId)!;
};

beforeAll(() => {
  // two seconds, made here: nothing large is committed
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", withSound]);
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'local', 'A', 'local', 0)").run();
});

describe("describe job", () => {
  it("an account with no AI connected → skipped as needs_key, never failed, nothing written", async () => {
    const v = await seed("ast-own-001", "local", "not a video");
    enqueueJob(libraryDb(), "lib_a", v, "describe", "local");
    expect(await tick()).toBe(true);
    expect(job(v, "describe")).toEqual({ state: "needs_key", error: expect.stringMatching(/No AI for your account/) });
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM descriptions WHERE version_id = ?").get(v)).toEqual({ n: 0 });
    expect((libraryDb().prepare("SELECT state FROM asset_versions WHERE id = ?").get(v) as { state: string }).state).toBe("ready");
    expect(completeVisionWithFallback).not.toHaveBeenCalled();
  });

  it("a job with no actor → needs_key, never the server's own AI", async () => {
    const v = await seed("ast-nobody-1", "local", "not a video");
    enqueueJob(libraryDb(), "lib_a", v, "describe", null);
    await tick();
    expect(job(v, "describe")?.state).toBe("needs_key");
    expect(completeVisionWithFallback).not.toHaveBeenCalled();
  });

  it("the prompt builder has no field for names or ages, and the answer keeps only description, tags and roll", () => {
    const p = describePrompt({ title: "Forward roll", transcript: "[0:00] Tuck the chin.", frames: 4 });
    expect(p.user).toMatch(/"roll": "a" or "b", "turn": 0\}$/);
    expect(p.user).not.toMatch(/creator|who/i); // A-roll is anyone talking to the camera, never a guess at who
    expect(parseDescribe('{"description": "A person talks.", "tags": [], "roll": "a"}').roll).toBe("a");
    expect(parseDescribe('{"description": "A person talks.", "tags": [], "roll": "maybe"}')).toEqual({ description: "A person talks.", tags: [] });
    expect(p.system).toMatch(/Never say who anyone is/);
    expect(parseDescribe('```json\n{"description": "A person rolls.", "tags": ["Roll", "roll", " mat "], "people": ["x"], "age": 3}\n```')).toEqual({
      description: "A person rolls.",
      tags: ["roll", "mat"],
    });
  });

  it("the clip's workspace instructions go in the prompt, so the AI can name the game it sees", async () => {
    const v = await seed("ast-ws-0001");
    expect(await workspaceOf(libraryDb(), v)).toBe(""); // no workspace yet
    mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
    const project = { id: "p-ember", owner: "local", name: "Ember Realm", audience: "fantasy RPG veterans", voice: "", cta: "", notes: "A free online fantasy RPG server.", createdAt: 1, updatedAt: 1 };
    writeFileSync(path.join(dir, "workshop", "projects", "p-ember.json"), JSON.stringify(project));
    const ws = await workspaceOf(libraryDb(), v);
    expect(ws).toMatch(/Workspace: Ember Realm[\s\S]*A free online fantasy RPG server/);
    expect(describePrompt({ title: "gameplay-1", frames: 4, workspace: ws }).user).toMatch(/^The workspace this clip belongs to[\s\S]*Ember Realm[\s\S]*Title: gameplay-1/);
    rmSync(path.join(dir, "workshop", "projects", "p-ember.json"));
  });

  it("the library's tags go in the prompt, most used first, without the clip's own or a trashed clip's", async () => {
    const d = libraryDb();
    const v = await seed("ast-voc-0001");
    await seed("ast-voc-0002");
    await seed("ast-voc-0003");
    const tag = d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, ?)");
    tag.run("ast-voc-0001", "own tag", "ai");
    tag.run("ast-voc-0002", "lava cave", "ai");
    tag.run("ast-voc-0003", "lava cave", "user");
    tag.run("ast-voc-0003", "boss fight", "ai");
    d.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast-voc-0003'").run();
    expect(tagsOf(d, v).list.map((t) => t.tag)).not.toContain("boss fight");
    d.prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast-voc-0003'").run();
    const tags = tagsOf(d, v);
    expect(tags.list.slice(0, 2)).toEqual([{ tag: "lava cave", count: 2 }, { tag: "boss fight", count: 1 }]);
    expect(tags.list.map((t) => t.tag)).not.toContain("own tag");
    const user = describePrompt({ title: "x", frames: 4, tags }).user;
    expect(user).toMatch(/what sets it apart[\s\S]*Tags already in this library of \d+ clips[^\n]*lava cave: 2, boss fight: 1/);
  });

  it("with a route: four frames go to the actor's AI; the description and AI tags are stored and searchable", async () => {
    const v = await seed("ast-ai-0001");
    // once for the turn on the AI (describeSlot), once for the job
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["mac"] }).mockReturnValueOnce({ only: ["mac"] });
    vi.mocked(completeVisionWithFallback).mockImplementationOnce(async (_s, _u, images, _c, parse) => {
      expect(images).toHaveLength(4);
      return { value: parse('{"description": "A person rolls across a blue mat.", "tags": ["roll", "mat"], "roll": "a"}'), provider: "test" } as never;
    });
    // a short clip, talked through: the speech alone can't call it, so the AI's answer in the same call settles it
    libraryDb().prepare(`UPDATE asset_versions SET probe = '{"duration":2,"vcodec":"h264","acodec":"aac"}' WHERE id = ?`).run(v);
    saveTranscript(libraryDb(), v, "device", "en", [{ start: 0, end: 2, text: "tuck the chin and roll over now like this okay" }]);
    libraryDb().prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES ('ast-ai-0001', 'mat', 'user')").run();
    enqueueJob(libraryDb(), "lib_a", v, "describe", "local");
    await tick();
    expect(job(v, "describe")?.state).toBe("done");
    expect(vi.mocked(aiFor).mock.calls.at(-1)![0]).toEqual({ username: "local", role: "admin" });
    const c = card("ast-ai-0001");
    expect(c.description).toEqual({ source: "ai", text: "A person rolls across a blue mat." });
    expect(c.aiTags).toEqual(["roll"]); // a human's tag keeps its source
    expect(c.roll).toBe("a"); // the worker sorted it again once the description came (roll.ts)
    const hits = (await (await call("local", "/api/library/lib_a/search?q=blue")).json()) as { asset: { id: string } }[];
    expect(hits.map((h) => h.asset.id)).toEqual(["ast-ai-0001"]);
  });

  it("probe queues fingerprint always and describe unless the library switched it off", async () => {
    const d = libraryDb();
    const run = async (id: string) => {
      const v = await seed(id);
      d.prepare("UPDATE asset_versions SET probe = NULL WHERE id = ?").run(v);
      enqueueJob(d, "lib_a", v, "probe", "local");
      while (job(v, "probe")?.state === "queued") await tick();
      return v;
    };
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.describe', json('false')) WHERE id = 'lib_a'`).run();
    const off = await run("ast-probe-01");
    expect(job(off, "fingerprint")?.state).toBe("queued");
    expect(job(off, "describe")).toBeUndefined();
    d.prepare(`UPDATE libraries SET settings = '{}' WHERE id = 'lib_a'`).run(); // on by default
    const on = await run("ast-probe-02");
    expect(job(on, "describe")?.state).toBe("queued");
    d.prepare(`UPDATE libraries SET settings = '{}' WHERE id = 'lib_a'`).run();
    while (await tick()); // thumb, wave, fingerprint; describe parks (the solo admin has no AI provider here)
    const f = d.prepare("SELECT inline FROM derivatives WHERE version_id = ? AND kind = 'fingerprint'").get(off) as { inline: string };
    expect(JSON.parse(f.inline).phash).toHaveLength(2); // one per second of the two-second clip
    expect(job(on, "describe")?.state).toBe("needs_key");
  });

  it("a file tagged as a song or a sound effect (use_file sound) gets no transcript, duplicate check or description", async () => {
    const d = libraryDb();
    const run = async (id: string, tag?: string) => {
      const v = await seed(id, "local", undefined, withSound);
      if (tag) d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'user')").run(id, tag);
      d.prepare("UPDATE asset_versions SET probe = NULL WHERE id = ?").run(v);
      enqueueJob(d, "lib_a", v, "probe", "local");
      while (job(v, "probe")?.state === "queued") await tick();
      return v;
    };
    const plain = await run("ast-sound-01");
    expect(job(plain, "transcribe")).toBeDefined();
    for (const [id, tag] of [["ast-sound-02", "music"], ["ast-sound-03", "sound effect"]] as const) {
      const v = await run(id, tag);
      expect([job(v, "transcribe"), job(v, "fingerprint"), job(v, "describe")]).toEqual([undefined, undefined, undefined]);
      expect(job(v, "wave")).toBeDefined();
    }
  });
});

describe("a clip filmed on its side", () => {
  it("the AI's turn and Rotate turn the card, its thumbnail and its strip, never the file", async () => {
    const v = await seed("ast-turn-001");
    libraryDb().prepare(`UPDATE asset_versions SET probe = '{"duration":2,"vcodec":"h264","width":160,"height":120}' WHERE id = ?`).run(v);
    const thumb = path.join(dir, "turn-thumb.jpg");
    execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-i", clip, "-frames:v", "1", thumb]);
    const key = `libraries/lib_a/v/${v}/thumb.jpg`;
    await blobs.put(key, thumb);
    libraryDb().prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', ?, 1)").run(v, key);
    const size = async () =>
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", await blobs.localCopy(key)]).toString().trim();
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["mac"] });
    vi.mocked(completeVisionWithFallback).mockImplementationOnce(
      async (_s, user, _i, _c, parse) => {
        expect(user).toContain("turn");
        return { value: parse('{"description": "A game recorded sideways.", "tags": [], "roll": "b", "turn": 270}'), provider: "test" } as never;
      },
    );
    // straight to the step: describe jobs queued by the tests above would take the AI's answer first
    await describeVersion(libraryDb(), v, clip, 2, "local", dir);
    let c = card("ast-turn-001");
    expect([c.turn, c.width, c.height]).toEqual([270, 120, 160]);
    expect(c.thumbUrl).toContain("?t=270");
    expect(await size()).toBe("120,160");
    expect(job(v, "sprite")?.state).toBe("queued"); // made again, upright
    // Rotate: a quarter clockwise from 270 is upright again
    expect((await call("local", "/api/library/lib_a/assets/ast-turn-001", "PATCH", { turn: 0 })).status).toBe(200);
    c = card("ast-turn-001");
    expect([c.turn, c.width, c.height]).toEqual([undefined, 160, 120]);
    expect(await size()).toBe("160,120");
  });
});

describe("a human description", () => {
  it("wins on the card and in search, whatever the AI writes after it", async () => {
    const v = await seed("ast-human-01", "local", "x");
    expect((await call("local", "/api/library/lib_a/assets/ast-human-01", "PATCH", { description: "Our best cartwheel take" })).status).toBe(200);
    saveDescribed(libraryDb(), v, { description: "A person turns sideways.", tags: ["cartwheel"] }, "test");
    expect(card("ast-human-01").description).toEqual({ source: "user", text: "Our best cartwheel take" });
    const row = libraryDb().prepare("SELECT description FROM search_assets WHERE asset_id = 'ast-human-01'").get() as { description: string };
    expect(row.description).toBe("Our best cartwheel take");
    // removed: the AI's shows again
    await call("local", "/api/library/lib_a/assets/ast-human-01", "PATCH", { description: "" });
    expect(card("ast-human-01").description).toEqual({ source: "ai", text: "A person turns sideways." });
  });

  it("tags are the whole list: one left out goes, a new one is the person's", async () => {
    const r = await call("local", "/api/library/lib_a/assets/ast-human-01", "PATCH", { tags: ["best take"] });
    expect((await r.json()) as { tags: string[]; aiTags: string[] }).toMatchObject({ tags: ["best take"], aiTags: [] });
  });

  it("an AI tag put back by an undo is the AI's again", async () => {
    await call("local", "/api/library/lib_a/assets/ast-human-01", "PATCH", { tags: ["best take"] });
    libraryDb().prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES ('ast-human-01', 'cartwheel', 'ai')").run();
    await call("local", "/api/library/lib_a/assets/ast-human-01", "PATCH", { tags: ["best take"] }); // removed
    const r = await call("local", "/api/library/lib_a/assets/ast-human-01", "PATCH", { tags: ["best take", "cartwheel"], aiTags: ["cartwheel"] });
    expect((await r.json()) as { aiTags: string[] }).toMatchObject({ aiTags: ["cartwheel"] });
  });

  it("only the owner edits; outsiders get 404", async () => {
    await seed("ast-local-01", "local", "x");
    expect((await call("stranger", "/api/library/lib_a/assets/ast-local-01", "PATCH", { description: "x" })).status).toBe(404);
  });
});
