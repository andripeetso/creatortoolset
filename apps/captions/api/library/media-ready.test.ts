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
  JSON.stringify({
    workspaces: [
      { id: "ws_p", name: "Tiny Acrobatics", members: [{ username: "ana", role: "owner" }, { username: "mem", role: "member" }] },
      { id: "ws_cat", name: "Tiny Catalog", members: [{ username: "ana", role: "owner" }, { username: "mem", role: "member" }] },
      // ana's team (Settings → Team): mem is given ws_cat and ws_shared, so their libraries have members (hasMembers)
      {
        id: "ana",
        name: "Tiny Acrobatics",
        plan: "team",
        createdAt: 0,
        members: [
          { username: "ana", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "mem", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["ws_cat", "ws_shared"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);
const { libraryDb } = await import("./db");
const { mediaReady, setupNeeded } = await import("./access");
const { migrateLibraries } = await import("./migrate");
const { Hono } = await import("hono");
const { mountPlugins } = await import("../lib/plugin");
const { workspaceScope } = await import("../lib/workshop/workspace");
// a plug-in that serves ws_cat's media itself (its own store, as a footage catalog does); every other workspace is the library's
mountPlugins(new Hono(), [{ id: "catalog", uploadsTo: () => (workspaceScope.getStore()?.id === "ws_cat" ? "catalog" : null) }]);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(() => {
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_p', 'ws_p', 'Library', 'local', ?, 0)")
    .run(JSON.stringify({ projectId: "ws_p" }));
});

describe("mediaReady", () => {
  it("is not ready until setupAt is set, and the owner sets it up while a member only sees it", async () => {
    expect(await mediaReady("ana", "ws_p")).toEqual({ ready: false, owner: true, libraryId: "lib_p" });
    expect(await mediaReady("mem", "ws_p")).toEqual({ ready: false, owner: false, libraryId: "lib_p" });
    expect(await setupNeeded("ana", "ws_p")).toMatchObject({ kind: "setup", owner: true, href: "/library?setup=1", workspaceName: "Tiny Acrobatics" });
    expect(await setupNeeded("mem", "ws_p")).toMatchObject({ kind: "setup", owner: false });
  });

  it("reads the workspace's library by projectId, whoever asks, and clears once setupAt is set", async () => {
    libraryDb().prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_p'").run(JSON.stringify({ projectId: "ws_p", setupAt: "2026-11-18T10:00:00.000Z" }));
    expect((await mediaReady("mem", "ws_p")).ready).toBe(true);
    expect(await setupNeeded("mem", "ws_p")).toBeNull();
  });

  it("says a workspace with no library is not set up, and a member of it is not the owner", async () => {
    expect(await mediaReady("mem", "ws_none")).toEqual({ ready: false, owner: false, libraryId: null });
  });

  it("without a projectId, the asker's own library", async () => {
    expect(await mediaReady("ana")).toEqual({ ready: true, owner: true, libraryId: "lib_p" });
  });

  it("a library that already has clips is set up by the migration at boot; one with none stays unset", async () => {
    libraryDb()
      .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_old', 'ana', 'Library', 'local', '{}', 0)")
      .run();
    libraryDb().exec("INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_old', 'lib_old', 'video', 'Old', 'ana', 0, NULL)");
    const changes = await migrateLibraries({ now: "2026-11-18T10:00:00.000Z" });
    expect(changes).toEqual([{ libraryId: "lib_old", field: "setupAt", from: null, to: "2026-11-18T10:00:00.000Z" }]);
    expect(libraryDb().prepare("SELECT json_extract(settings, '$.setupAt') AS s FROM libraries WHERE id = 'lib_old'").get()).toEqual({ s: "2026-11-18T10:00:00.000Z" });
    expect(await migrateLibraries()).toEqual([]);   // idempotent
  });
});

describe("a workspace a plug-in serves itself (its catalog)", () => {
  const setupAt = (id: string) => (libraryDb().prepare("SELECT json_extract(settings, '$.setupAt') AS s FROM libraries WHERE id = ?").get(id) as { s: string | null }).s;
  const add = (id: string, ws: string, settings: Record<string, unknown> = {}) =>
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'ana', 'Library', 'local', ?, 0)").run(id, JSON.stringify({ projectId: ws, ...settings }));

  it("an empty core library there is ready: no setup card, and setupAt is written once (no dialog)", async () => {
    add("lib_cat", "ws_cat");
    expect(await mediaReady("mem", "ws_cat")).toEqual({ ready: true, owner: false, libraryId: "lib_cat" });
    expect(await setupNeeded("ana", "ws_cat")).toBeNull();
    const at = setupAt("lib_cat");
    expect(at).toEqual(expect.any(String));
    await mediaReady("ana", "ws_cat");
    expect(setupAt("lib_cat")).toBe(at);
  });

  it("a plain empty workspace is still not ready", async () => {
    add("lib_plain", "ws_plain");
    expect((await mediaReady("ana", "ws_plain")).ready).toBe(false);
    expect(await setupNeeded("ana", "ws_plain")).toMatchObject({ kind: "setup" });
    expect(setupAt("lib_plain")).toBeNull();
  });

  it("the migration sets it up once and leaves its upload alone though it has members; a plain shared one gets proxies", async () => {
    libraryDb().exec("DELETE FROM libraries WHERE id IN ('lib_cat', 'lib_plain')");
    // both are given to mem (Settings → Team), so both have members, and both keep no Hosted media
    add("lib_cat", "ws_cat", { upload: "none" });
    add("lib_shared", "ws_shared", { upload: "none" });
    const changes = await migrateLibraries({ now: "2026-11-19T10:00:00.000Z" });
    expect(changes.filter((c) => c.libraryId === "lib_cat")).toEqual([{ libraryId: "lib_cat", field: "setupAt", from: null, to: "2026-11-19T10:00:00.000Z" }]);
    expect(changes.filter((c) => c.libraryId === "lib_shared")).toEqual([{ libraryId: "lib_shared", field: "upload", from: "none", to: "proxies" }]);
    expect(await migrateLibraries()).toEqual([]); // idempotent
  });
});
