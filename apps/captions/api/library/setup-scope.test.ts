import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 11-19: a folder row shared with every workspace marked every workspace's library set up (migration item 3), so new
// workspaces skipped setup. (a) Item 3 counts only rows of that workspace alone. (b) The correction clears what it set.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "setup-scope-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STAMP = "2026-11-19T10:22:00.000Z";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "tinyacrobatics", name: "Tiny Acrobatics", plan: "team", createdAt: 0, members: [{ username: "tinyacrobatics", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }],
    invites: [],
    spend: {},
  }),
);
// the folder list: one Exports row for every workspace, one Source media row of ws_own alone, one shared by two workspaces
mkdirSync(path.join(dir, "storage"), { recursive: true });
const row = (id: string, role: string, p: string, ws: { workspace?: string; workspaces?: string[] }) => ({ id, role, name: path.basename(p), origin: { host: "mac_tiny", path: p }, make: false, createdAt: 1, reach: {}, ...ws });
writeFileSync(
  path.join(dir, "storage", "tinyacrobatics.json"),
  JSON.stringify({
    schemaVersion: 3,
    folders: [
      row("f-exports", "library", "/Volumes/Tiny/Exports", { workspace: "*" }),
      row("f-own", "footage", "/Volumes/Tiny/Own", { workspace: "ws_own" }),
      row("f-two", "footage", "/Volumes/Tiny/Two", { workspaces: ["ws_new", "ws_other"] }),
    ],
  }),
);

const { createUser } = await import("../users");
createUser("tinyacrobatics", "fixture-password-only");
const { libraryDb } = await import("./db");
const { migrateLibraries, ownRow } = await import("./migrate");
const { correctSetups } = await import("./setup-correction");
const d = libraryDb();
const lib = (id: string, s: object) => d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tinyacrobatics', 'Library', 'local', ?, 0)").run(id, JSON.stringify(s));
const setupAt = (id: string) => (d.prepare("SELECT json_extract(settings, '$.setupAt') AS v FROM libraries WHERE id = ?").get(id) as { v: string | null }).v;

describe("(a) migration item 3: only a workspace's own folder rows say it was set up", () => {
  it("ownRow: a row of that workspace alone; never one for every workspace or shared with another", () => {
    expect(ownRow({ workspace: "ws_own" }, "ws_own")).toBe(true);
    expect(ownRow({ workspace: "*" }, "ws_own")).toBe(false);
    expect(ownRow({ workspaces: ["ws_new", "ws_other"] }, "ws_new")).toBe(false);
    expect(ownRow({ workspace: "ws_own" }, "ws_new")).toBe(false);
    // a library from before workspaces counts rows from before workspaces only
    expect(ownRow({}, undefined)).toBe(true);
    expect(ownRow({ workspace: "ws_own" }, undefined)).toBe(false);
  });

  it("an empty workspace library with only an every-workspace Exports row (and a row shared with another) gets no setupAt", async () => {
    lib("lib_new", { projectId: "ws_new" });
    lib("lib_own", { projectId: "ws_own" });
    const changes = (await migrateLibraries({ dryRun: true, now: STAMP })).filter((c) => c.field === "setupAt");
    expect(changes.map((c) => c.libraryId)).toEqual(["lib_own"]);
    d.prepare("DELETE FROM libraries").run();
  });
});

describe("(b) the correction", () => {
  it("clears only migration-stamped setups with no clips, watch, own folder rows or saved answers; dry run by default", async () => {
    mkdirSync(path.join(dir, "library"), { recursive: true });
    writeFileSync(path.join(dir, "library", "migrated.json"), JSON.stringify({ "4.6": STAMP }));
    lib("lib_wrong", { projectId: "ws_new", setupAt: STAMP, organize: "ai", lookBudget: null });
    lib("lib_done", { projectId: "ws_done", setupAt: STAMP, importMode: "copy" });
    lib("lib_clips", { projectId: "ws_clips", setupAt: STAMP });
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_1', 'lib_clips', 'video', 'V', 'tinyacrobatics', 0)").run();
    lib("lib_watch", { projectId: "ws_watch", setupAt: STAMP, watch: [{ path: "/Volumes/Tiny/Watch" }] });
    lib("lib_ownrow", { projectId: "ws_own", setupAt: STAMP });
    lib("lib_later", { projectId: "ws_later", setupAt: "2026-11-19T14:58:41.000Z" });
    lib("lib_none", { projectId: "ws_none" });

    const dry = await correctSetups();
    expect(dry.stamp).toBe(STAMP);
    expect(Object.fromEntries(dry.rows.map((r) => [r.id, r.action]))).toEqual({
      lib_wrong: "clear",
      lib_done: "has setup answers saved",
      lib_clips: "has clips",
      lib_watch: "has watch folders",
      lib_ownrow: "has folder rows of its own workspace",
      lib_later: "set up by a Done or a plug-in, not the migration",
      lib_none: "not set up",
    });
    expect(dry.rows.find((r) => r.id === "lib_clips")).toMatchObject({ clips: 1, ownFolders: 0, projectId: "ws_clips" });
    expect(setupAt("lib_wrong")).toBe(STAMP); // the dry run wrote nothing

    await correctSetups({ write: true });
    expect(setupAt("lib_wrong")).toBeNull();
    for (const id of ["lib_done", "lib_clips", "lib_watch", "lib_ownrow"]) expect(setupAt(id)).toBe(STAMP);
    expect(setupAt("lib_later")).toBe("2026-11-19T14:58:41.000Z");
    // a second run finds nothing more to clear
    expect((await correctSetups({ write: true })).rows.filter((r) => r.action === "clear")).toEqual([]);
  });
});
