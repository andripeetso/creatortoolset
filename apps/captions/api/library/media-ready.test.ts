import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "media-ready-"));
process.env.DATA_DIR = dir;
writeFileSync(
  path.join(dir, "users.json"),
  JSON.stringify({
    users: [
      { username: "ana", salt: "", hash: "", role: "user", cloud: true, off: [], createdAt: 0 },
      { username: "mem", salt: "", hash: "", role: "user", cloud: true, off: [], createdAt: 0 },
    ],
  }),
);
// ana owns ws_p; mem is a member of it. Its library is kept under ana's home, tagged with the workspace's projectId.
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "ws_p", name: "Tiny Acrobatics", members: [{ username: "ana", role: "owner" }, { username: "mem", role: "member" }] }] }),
);
const { libraryDb } = await import("./db");
const { mediaReady, setupNeeded } = await import("./access");
const { migrateLibraries } = await import("./migrate");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(() => {
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_p', 'ws_p', 'Library', 'local', ?, 0)")
    .run(JSON.stringify({ projectId: "ws_p" }));
});

describe("mediaReady", () => {
  it("is not ready until setupAt is set, and the owner sets it up while a member only sees it", () => {
    expect(mediaReady("ana", "ws_p")).toEqual({ ready: false, owner: true, libraryId: "lib_p" });
    expect(mediaReady("mem", "ws_p")).toEqual({ ready: false, owner: false, libraryId: "lib_p" });
    expect(setupNeeded("ana", "ws_p")).toMatchObject({ kind: "setup", owner: true, href: "/library?setup=1", workspaceName: "Tiny Acrobatics" });
    expect(setupNeeded("mem", "ws_p")).toMatchObject({ kind: "setup", owner: false });
  });

  it("reads the workspace's library by projectId, whoever asks, and clears once setupAt is set", () => {
    libraryDb().prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_p'").run(JSON.stringify({ projectId: "ws_p", setupAt: "2026-11-18T10:00:00.000Z" }));
    expect(mediaReady("mem", "ws_p").ready).toBe(true);
    expect(setupNeeded("mem", "ws_p")).toBeNull();
  });

  it("says a workspace with no library is not set up, and a member of it is not the owner", () => {
    expect(mediaReady("mem", "ws_none")).toEqual({ ready: false, owner: false, libraryId: null });
  });

  it("without a projectId, the asker's own library", () => {
    expect(mediaReady("ana")).toEqual({ ready: true, owner: true, libraryId: "lib_p" });
  });

  it("a library that already has clips is set up by the migration at boot; one with none stays unset", async () => {
    libraryDb()
      .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_old', 'ana', 'Library', 'local', '{}', 0)")
      .run();
    libraryDb().exec("INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_old', 'lib_old', 'video', 'Old', 'ana', 0, NULL)");
    const changes = await migrateLibraries({ now: "2026-11-18T10:00:00.000Z" });
    expect(changes).toEqual([{ libraryId: "lib_old", field: "setupAt", from: null, to: "2026-11-18T10:00:00.000Z" }]);
    expect(libraryDb().prepare("SELECT json_extract(settings, '$.setupAt') AS s FROM libraries WHERE id = 'lib_old'").get()).toEqual({ s: "2026-11-18T10:00:00.000Z" });
    expect(libraryDb().prepare("SELECT json_extract(settings, '$.setupAt') AS s FROM libraries WHERE id = 'lib_p'").get()).toEqual({ s: null });   // no clips: still unset
    expect(await migrateLibraries()).toEqual([]);   // idempotent
  });
});
