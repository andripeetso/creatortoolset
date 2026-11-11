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
const { describePrompt, parseDescribe, saveDescribed } = await import("./describe");
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

/** An asset with one ready video version; its source is the fixture clip unless `bytes` is given. */
async function seed(id: string, by = "local", bytes?: string) {
  const d = libraryDb();
  const v = `ver-${id}`;
  const file = path.join(dir, `src-${id}`);
  if (bytes) writeFileSync(file, bytes);
  else copyFileSync(clip, file);
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
    expect(p.user).toMatch(/"roll": "a" or "b"\}$/);
    expect(p.user).not.toMatch(/creator|who/i); // A-roll is anyone talking to the camera, never a guess at who
    expect(parseDescribe('{"description": "A person talks.", "tags": [], "roll": "a"}').roll).toBe("a");
    expect(parseDescribe('{"description": "A person talks.", "tags": [], "roll": "maybe"}')).toEqual({ description: "A person talks.", tags: [] });
    expect(p.system).toMatch(/Never say who anyone is/);
    expect(parseDescribe('```json\n{"description": "A person rolls.", "tags": ["Roll", "roll", " mat "], "people": ["x"], "age": 3}\n```')).toEqual({
      description: "A person rolls.",
      tags: ["roll", "mat"],
    });
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

  it("only the owner edits; outsiders get 404", async () => {
    await seed("ast-local-01", "local", "x");
    expect((await call("stranger", "/api/library/lib_a/assets/ast-local-01", "PATCH", { description: "x" })).status).toBe(404);
  });
});
