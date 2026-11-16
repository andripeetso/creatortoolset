import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkResult } from "../../contracts/work";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-result-"));
process.env.DATA_DIR = dir;

const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { buildPackage } = await import("./package");
const { acceptUpload, applyResult, MAX_CACHE } = await import("./result");
type JobRow = import("../library/jobs").JobRow;

const EDIT = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const me = { id: "dev_mine", owner: "maker" };
const editDir = path.join(dir, "editor", EDIT);
const read = (rel: string) => JSON.parse(readFileSync(path.join(editDir, rel), "utf8"));
const put = (rel: string, v: unknown) => {
  mkdirSync(path.dirname(path.join(editDir, rel)), { recursive: true });
  writeFileSync(path.join(editDir, rel), JSON.stringify(v));
};
const draft = (n: number) => ({ timeline: { sources: { ver_a1: {} } }, notes: [`cut ${n}`] });

function held(variant: string, kind: string, device = me.id): JobRow {
  const db = libraryDb();
  const vid = `${EDIT}:${variant}`;
  enqueueJob(db, "maker", vid, kind, "maker", true, "edit_jobs");
  db.prepare("UPDATE edit_jobs SET state = 'running', attempts = 1, device = ?, lease_until = ? WHERE version_id = ? AND kind = ?").run(device, Date.now() + 300_000, vid, kind);
  return db.prepare("SELECT * FROM edit_jobs WHERE version_id = ? AND kind = ?").get(vid, kind) as unknown as JobRow;
}
const result = (r: Partial<WorkResult> & { put?: Record<string, string>; gone?: string[] }): WorkResult => ({
  v: 1,
  outcome: { done: true },
  edit: { put: r.put ?? {}, gone: r.gone ?? [] },
  uploads: r.uploads ?? [],
  effects: r.effects ?? {},
  ...(r.kept ? { kept: r.kept } : {}),
  ...(r.outcome ? { outcome: r.outcome } : {}),
});
const row = (id: number) => libraryDb().prepare("SELECT state, device, error FROM edit_jobs WHERE id = ?").get(id) as { state: string; device: string | null; error: string | null };

beforeAll(() => {
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_a1', 'ast_a1', 1, 'k1', 100, 'x1', 'ready', 'maker', 0);
  `);
  put("edit.json", { id: EDIT, name: "Test", workspaceId: "maker", createdBy: "maker", createdAt: 0, updatedAt: 0, sources: ["ver_a1"] });
  put("drafts/v1.json", draft(1));
  put("drafts/v2.json", draft(1));
  mkdirSync(path.join(dir, "editor", OTHER), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("applyResult", () => {
  it("merges two versions' results per top-level key, so neither overwrites the other", async () => {
    put("shots.json", { v3: { plan: "kept" } });
    const j1 = held("v1", "critique");
    const j2 = held("v2", "critique", "dev_two");
    // both computers got the same files
    const p1 = await buildPackage(j1, me);
    await buildPackage(j2, { id: "dev_two", owner: "maker" });
    // v1 comes back first; v2 was made from the package before v1's result
    const s1 = { ...JSON.parse(p1.edit["shots.json"]!), v1: { plan: 1 } };
    expect(await applyResult(j1.id, me.id, result({ put: { "shots.json": JSON.stringify(s1), "post.json": JSON.stringify({ v1: { files: {}, notes: ["a"] } }) } }))).toBe(true);
    const s2 = { ...JSON.parse(p1.edit["shots.json"]!), v2: { plan: 2 } };
    expect(await applyResult(j2.id, "dev_two", result({ put: { "shots.json": JSON.stringify(s2), "post.json": JSON.stringify({ v2: { files: {}, notes: ["b"] } }) } }))).toBe(true);
    expect(read("shots.json")).toEqual({ v1: { plan: 1 }, v2: { plan: 2 }, v3: { plan: "kept" } });
    expect(read("post.json")).toEqual({ v1: { files: {}, notes: ["a"] }, v2: { files: {}, notes: ["b"] } });
    expect(row(j1.id).state).toBe("done");
    // a key the step removed goes; a rename made meanwhile on the server stays
    const j3 = held("v1", "draft");
    const p3 = await buildPackage(j3, me);
    put("edit.json", { ...read("edit.json"), name: "Renamed" });
    const { v3: _, ...rest } = JSON.parse(p3.edit["shots.json"]!);
    await applyResult(j3.id, me.id, result({ put: { "shots.json": JSON.stringify(rest), "edit.json": JSON.stringify({ ...JSON.parse(p3.edit["edit.json"]!), updatedAt: 5 }) } }));
    expect(read("shots.json")).toEqual({ v1: { plan: 1 }, v2: { plan: 2 } });
    expect(read("edit.json")).toMatchObject({ name: "Renamed", updatedAt: 5 });
  });

  it("saves a new draft revision through the server's own rotation", async () => {
    put("drafts/v2.r1.json", draft(0));
    const j = held("v2", "draft");
    const pkg = await buildPackage(j, me);
    // the server made another revision meanwhile
    put("drafts/v2.r2.json", draft(0));
    // the computer's saveDraft moved its v2.json to v2.r2.json and wrote the new cut
    await applyResult(j.id, me.id, result({ put: { "drafts/v2.r2.json": pkg.edit["drafts/v2.json"]!, "drafts/v2.json": JSON.stringify(draft(2)) } }));
    expect(read("drafts/v2.json")).toEqual(draft(2));
    expect(read("drafts/v2.r3.json")).toEqual(draft(1));
    expect(read("drafts/v2.r2.json")).toEqual(draft(0));
  });

  it("removes only files the server has not changed since", async () => {
    put("cards/a.json", { a: 1 });
    put("cards/b.json", { b: 1 });
    const j = held("v1", "critique");
    await buildPackage(j, me);
    put("cards/b.json", { b: 2 });
    await applyResult(j.id, me.id, result({ gone: ["cards/a.json", "cards/b.json", "../edit.json"] }));
    expect(existsSync(path.join(editDir, "cards/a.json"))).toBe(false);
    expect(read("cards/b.json")).toEqual({ b: 2 });
    expect(existsSync(path.join(editDir, "edit.json"))).toBe(true);
  });

  it("applies nothing once the computer lost the step", async () => {
    const j = held("v1", "preview");
    await buildPackage(j, me);
    const before = readFileSync(path.join(editDir, "shots.json"), "utf8");
    // the lease went back to the queue, then another computer took it
    libraryDb().prepare("UPDATE edit_jobs SET device = 'dev_two' WHERE id = ?").run(j.id);
    expect(await applyResult(j.id, me.id, result({ put: { "shots.json": "{}" }, effects: { queue: [{ version: `${EDIT}:v1`, kind: "file" }] } }))).toBe(false);
    expect(readFileSync(path.join(editDir, "shots.json"), "utf8")).toBe(before);
    expect(libraryDb().prepare("SELECT 1 FROM edit_jobs WHERE version_id = ? AND kind = 'file'").get(`${EDIT}:v1`)).toBeUndefined();
    // stopped: the same
    libraryDb().prepare("UPDATE edit_jobs SET device = ?, state = 'failed' WHERE id = ?").run(me.id, j.id);
    expect(await applyResult(j.id, me.id, result({}))).toBe(false);
  });

  it("queues only this edit's versions and core kinds, keeps post copies on the computer, and classifies the outcome", async () => {
    const j = held("v1", "post");
    await buildPackage(j, me);
    const ok = await applyResult(
      j.id,
      me.id,
      result({
        kept: { ver_a1: "/Users/maker/work/post/v1/a.mov" },
        outcome: { wait: { seconds: 30, line: "Waits for the transcript" } },
        effects: { queue: [{ version: `${EDIT}:v1`, kind: "file" }, { version: `${OTHER}:v1`, kind: "file" }, { version: `${EDIT}:v1`, kind: "card-draw" }, { version: `${EDIT}:../x`, kind: "draft" }] },
      }),
    );
    expect(ok).toBe(true);
    expect(read("post.json").v1).toEqual({ files: { ver_a1: "/Users/maker/work/post/v1/a.mov" }, notes: ["a"], on: me.id });
    const queued = libraryDb().prepare("SELECT version_id, kind FROM edit_jobs WHERE kind IN ('file', 'card-draw') OR version_id LIKE ?").all(`${OTHER}%`);
    expect(queued).toEqual([{ version_id: `${EDIT}:v1`, kind: "file" }]);
    expect(row(j.id)).toEqual({ state: "queued", device: null, error: "Waits for the transcript" });

    const k = held("v1", "preview");
    await buildPackage(k, me);
    await applyResult(k.id, me.id, result({ outcome: { needsKey: "No AI for your account" } }));
    expect(row(k.id)).toMatchObject({ state: "needs_key", device: null });
    const e = held("v2", "preview");
    await buildPackage(e, me);
    await applyResult(e.id, me.id, result({ outcome: { error: "ffmpeg said no" } }));
    expect(row(e.id)).toMatchObject({ state: "queued", device: null, error: "ffmpeg said no" });
  });
});

describe("acceptUpload", () => {
  it("takes only allowed paths of the step it holds, and moves them into place on apply", async () => {
    const j = held("v1", "preview");
    await buildPackage(j, me);
    const body = (s: string) => Readable.from([Buffer.from(s)]);
    for (const bad of ["../x.mp4", "/etc/passwd", `editor/${EDIT}/../${OTHER}/x.mp4`, `editor/${OTHER}/previews/v1.mp4`, `editor/${EDIT}/edit.json`, `editor/${EDIT}/previews/plan.json`, `editor/${EDIT}/.incoming/1/x.mp4`, "editor/cache/ver_zz.energy.f32", "editor/cache/ver_a1.sh", "library/library.db"]) {
      expect(await acceptUpload(j.id, me.id, bad, body("x")), bad).toBe(false);
    }
    expect(await acceptUpload(j.id, "dev_two", `editor/${EDIT}/previews/v1.mp4`, body("x"))).toBe(false);
    expect(await acceptUpload(j.id, me.id, "editor/cache/ver_a1.energy.f32", Readable.from([Buffer.alloc(MAX_CACHE + 1)]))).toBe(false);
    expect(await acceptUpload(j.id, me.id, `editor/${EDIT}/previews/v1.mp4`, body("video"))).toBe(true);
    expect(await acceptUpload(j.id, me.id, `editor/${EDIT}/previews/v1.wave.json`, body("{}"))).toBe(true);
    expect(await acceptUpload(j.id, me.id, "editor/cache/ver_a1.energy.f32", body("energy"))).toBe(true);
    expect(readdirSync(path.join(dir, "editor", OTHER))).toEqual([]);
    await applyResult(j.id, me.id, result({ uploads: [`editor/${EDIT}/previews/v1.mp4`, "editor/cache/ver_a1.energy.f32"] }));
    expect(readFileSync(path.join(editDir, "previews/v1.mp4"), "utf8")).toBe("video");
    expect(readFileSync(path.join(dir, "editor/cache/ver_a1.energy.f32"), "utf8")).toBe("energy");
    expect(existsSync(path.join(editDir, ".incoming", String(j.id)))).toBe(false);
  });
});
