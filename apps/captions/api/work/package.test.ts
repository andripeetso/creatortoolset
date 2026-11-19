import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-package-"));
process.env.DATA_DIR = dir;
// the studio suite runs hosted (CT_MODE=hosted), where a server does video work only by a plug-in's grant (serverWorks):
// this file's server is its own, so the mode is cleared here and put back after
const hostedWas = process.env.CT_MODE;
delete process.env.CT_MODE;

const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { buildPackage, ownFile, readKept } = await import("./package");
type JobRow = import("../library/jobs").JobRow;

const EDIT = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const me = { id: "dev_mine", owner: "maker" };

const writeEdit = (id: string, sources: string[], draft?: Record<string, { file?: string }>, extra: object = {}) => {
  const d = path.join(dir, "editor", id);
  mkdirSync(path.join(d, "drafts"), { recursive: true });
  writeFileSync(path.join(d, "edit.json"), JSON.stringify({ id, name: "Test", workspaceId: "maker", createdBy: "maker", createdAt: 0, updatedAt: 0, sources, ...extra }));
  if (draft) writeFileSync(path.join(d, "drafts", "v1.json"), JSON.stringify({ timeline: { sources: draft }, notes: [] }));
};

/** A step of `editId` for `variant`, running on `device`. */
function held(editId: string, variant: string, kind: string, device = me.id, actor = "maker"): JobRow {
  const db = libraryDb();
  enqueueJob(db, "maker", `${editId}:${variant}`, kind, actor, true, "edit_jobs");
  db.prepare("UPDATE edit_jobs SET state = 'running', device = ?, lease_until = ? WHERE version_id = ? AND kind = ?").run(device, Date.now() + 300_000, `${editId}:${variant}`, kind);
  return db.prepare("SELECT * FROM edit_jobs WHERE version_id = ? AND kind = ?").get(`${editId}:${variant}`, kind) as unknown as JobRow;
}

beforeAll(() => {
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, storage_config, created_at) VALUES
      ('lib_a', 'maker', 'A', 's3', '{"secretAccessKey":"shh"}', 0),
      ('lib_b', 'other', 'B', 'local', NULL, 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES
      ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0), ('ast_a2', 'lib_a', 'video', 'Take 2', 'maker', 0),
      ('ast_a3', 'lib_a', 'video', 'B-roll', 'maker', 0), ('ast_b1', 'lib_b', 'video', 'Not yours', 'other', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device, quick) VALUES
      ('ver_a1', 'ast_a1', 1, 'k1', 100, 'mac:q1', 'ready', 'maker', 0, '/Users/maker/Footage/take1.mov', 'dev_mine', 'q1'),
      ('ver_a2', 'ast_a2', 1, 'k2', 200, 'x2', 'ready', 'maker', 0, NULL, NULL, NULL),
      ('ver_a3', 'ast_a3', 1, 'k3', 300, 'x3', 'ready', 'maker', 0, NULL, NULL, NULL),
      ('ver_b1', 'ast_b1', 1, 'kb', 400, 'xb', 'ready', 'other', 0, NULL, NULL, NULL);
    INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('ver_a2', 'proxy', 'p2', 20), ('ver_a3', 'proxy', 'p3', 30);
    INSERT INTO transcripts (version_id, provider, text, segments, created_at) VALUES ('ver_a1', 't', 'hi', '[]', 0), ('ver_b1', 't', 'theirs', '[]', 0);
  `);
  // ver_a1's caches are on the server already
  mkdirSync(path.join(dir, "editor", "cache"), { recursive: true });
  for (const ext of ["energy.f32", "eyeline.json"]) writeFileSync(path.join(dir, "editor", "cache", `ver_a1.${ext}`), "c");
  writeEdit(EDIT, ["ver_a1", "ver_a2"], { ver_a1: {}, ver_a3: {}, card: { file: "cards/c1.mp4" } }, { steps: [{ id: "face-blur", values: {} }] });
  mkdirSync(path.join(dir, "editor", EDIT, "cards"), { recursive: true });
  writeFileSync(path.join(dir, "editor", EDIT, "cards", "c1.mp4"), "card");
  writeFileSync(path.join(dir, "editor", EDIT, "plan.json"), JSON.stringify({ lines: [], plans: [], notes: [] }));
  writeEdit(THEIRS, ["ver_a1"], { ver_b1: {} });
});
afterAll(() => {
  if (hostedWas !== undefined) process.env.CT_MODE = hostedWas;
  rmSync(dir, { recursive: true, force: true });
});

describe("buildPackage", () => {
  it("holds only the job's rows, with no bucket settings, and keeps the server's copy", async () => {
    const job = held(EDIT, "v1", "preview");
    const pkg = await buildPackage(job, me);
    expect(pkg.job).toMatchObject({ id: job.id, kind: "preview", editId: EDIT, variant: "v1", actor: "maker", workspaceId: "maker" });
    expect(pkg.rows.libraries).toEqual([expect.objectContaining({ id: "lib_a", storage_kind: "local", storage_config: null })]);
    expect(JSON.stringify(pkg)).not.toContain("shh");
    expect(JSON.stringify(pkg.rows)).not.toContain("ver_b1");
    // the edit's sources and the draft's B-roll
    expect(pkg.rows.asset_versions!.map((v) => v.id).sort()).toEqual(["ver_a1", "ver_a2", "ver_a3"]);
    expect(pkg.rows.edit_jobs!.every((r) => r.edit_id === EDIT)).toBe(true);
    expect(Object.keys(pkg.edit).sort()).toEqual(["drafts/v1.json", "edit.json", "plan.json"]);
    expect(pkg.caches).toEqual({ "ver_a1.energy.f32": "Yw==", "ver_a1.eyeline.json": "Yw==" });
    expect(pkg.own).toEqual([expect.objectContaining({ path: "cards/c1.mp4", bytes: 4 })]);
    expect(readKept(job.id)).toEqual(pkg);
  });

  it("lists the files the step reads, with this computer's own path and the proxy", async () => {
    // replaced (UNIFIED-PRD §4.7): with the server's video work on, the server runs the preview itself and no copy is listed
    // for the computer (reach.ts atFor), so the copy case is checked with the work off (the setup file turns it on)
    const { writeServerWork } = await import("./server-work");
    writeServerWork({ on: false });
    const preview = await buildPackage(held(EDIT, "v1", "preview"), me);
    writeServerWork({ on: true });
    expect(preview.files).toEqual([
      { id: "ver_a1", title: "Take 1", bytes: 100, quick: "q1", path: "/Users/maker/Footage/take1.mov" },
      { id: "ver_a3", title: "B-roll", bytes: 300, proxy: { bytes: 30 } },
    ]);
    // another computer of the same account does not get the first one's path
    expect((await buildPackage(held(EDIT, "v1", "preview", "dev_other"), { id: "dev_other", owner: "maker" })).files[0]!.path).toBeUndefined();
    // analyze: only the source whose caches are missing
    expect((await buildPackage(held(EDIT, "", "analyze"), me)).files.map((f) => f.id)).toEqual(["ver_a2"]);
    // post with plug-in steps: originals, and the steps it must have
    const post = await buildPackage(held(EDIT, "v1", "post"), me);
    expect(post.files.every((f) => f.original)).toBe(true);
    expect(post.steps).toEqual(["face-blur"]);
  });

  it("refuses another account's step and a draft that names someone else's footage", async () => {
    // a step of an edit the account can't see, asked for in its name
    await expect(buildPackage(held(EDIT, "v1", "critique", "dev_x", "other"), { id: "dev_x", owner: "other" })).rejects.toThrow(/cannot be read by this account/);
    await expect(buildPackage(held(EDIT, "v1", "draft", "dev_x"), { id: "dev_x", owner: "other" })).rejects.toThrow(/not this computer's account/);
    await expect(buildPackage(held(THEIRS, "v1", "preview"), me)).rejects.toThrow(/cannot be read by this account/);
  });
});

describe("ownFile", () => {
  it("serves only the paths the package listed, inside the edit's folder", async () => {
    const job = held(EDIT, "v1", "preview");
    await buildPackage(job, me);
    expect(ownFile(job.id, "cards/c1.mp4")).toBe(path.join(dir, "editor", EDIT, "cards", "c1.mp4"));
    expect(ownFile(job.id, "edit.json")).toBeNull();
    expect(ownFile(job.id, "../" + THEIRS + "/edit.json")).toBeNull();
    expect(ownFile(99_999, "cards/c1.mp4")).toBeNull();
  });
});
