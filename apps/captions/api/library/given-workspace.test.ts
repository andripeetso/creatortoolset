import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A member the team's owner gave one of their workspaces (Settings → Team → Access) sees the owner's library there and
// opens it, read-only: no other workspace's library, and nothing they change reaches it. With the Media Library on
// Read & write they add footage to it, never change or delete what is there.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-given-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIRST = "bbbbbbbb-0000-4000-8000-000000000001";
const SECOND = "bbbbbbbb-0000-4000-8000-000000000002";
const projects = path.join(dir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
for (const [id, at] of [[FIRST, 1], [SECOND, 2]] as const) {
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
}
const member = (username: string, workspaces?: string[]) => ({ username, role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ ...member("ana"), role: "owner" }, member("bo", [FIRST]), member("cy")] }],
    invites: [],
    spend: {},
  }),
);

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { inRequestWorkspace } = await import("../lib/workspace-scope");
const { isTeamMember } = await import("../lib/workspaces");

// ana's libraries carry her team's id (homeOf, access.ts). lib_old is from before workspaces, so the first brand's; lib_two is the second's
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_old', 't', 'Old', 'local', 0)").run();
libraryDb().prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_two', 't', 'Two', 'local', '{"projectId":"${SECOND}"}', 1)`).run();

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  // "bo:read": bo with the Media Library on Read (Settings → Team → Access)
  // "bo:admin": bo as an admin account, still a member of ana's team
  const [username, read] = (c.req.header("x-test-user") ?? "").split(":");
  c.set("user", { username, role: read === "admin" ? "admin" : "user", off: [], read: read === "read" ? ["media"] : [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", collectionApp);
app.route("/api/library", libraryApp);

const call = (user: string, url: string, init: RequestInit = {}, ws?: string) =>
  app.request(url, { ...init, headers: { "x-test-user": user, "content-type": "application/json", ...(ws ? { "x-ct-workspace": ws } : {}) } });

it("lists and opens the owner's library in the given workspace only, read-only", async () => {
  const listed = (await (await call("bo", "/api/library", {}, FIRST)).json()) as { libraries: { id: string; readOnly?: boolean }[] };
  expect(listed.libraries).toEqual([expect.objectContaining({ id: "lib_old", readOnly: true, canAdd: true })]);
  expect((await call("bo", "/api/library/lib_old/assets")).status).toBe(200);
  expect((await call("bo", "/api/library/lib_old/collections")).status).toBe(200);
  expect((await call("bo", "/api/library/lib_two/assets")).status).toBe(404);
  expect((await call("cy", "/api/library/lib_old/assets")).status).toBe(404);
  // writes ask whose library it is: never the member's
  expect((await call("bo", "/api/library/lib_old", { method: "PATCH", body: JSON.stringify({ name: "Mine" }) })).status).toBe(404);
  expect((await call("bo", "/api/library/lib_old/assets/ast_x", { method: "DELETE" })).status).toBe(403);
  // with the Media Library on Read & write the member adds footage to it; on Read not even that
  const check = { method: "POST", body: JSON.stringify({ size: 10 }) };
  expect((await call("bo", "/api/library/lib_old/uploads/check", check)).status).toBe(200);
  expect((await call("bo:read", "/api/library/lib_old/uploads/check", check)).status).toBe(404);
  const asReader = (await (await call("bo:read", "/api/library", {}, FIRST)).json()) as { libraries: { canAdd?: boolean }[] };
  expect(asReader.libraries[0]!.canAdd).toBeUndefined();
  // the owner's own view is as before
  const own = (await (await call("ana", "/api/library", {}, FIRST)).json()) as { libraries: { id: string; readOnly?: boolean }[] };
  expect(own.libraries).toEqual([expect.objectContaining({ id: "lib_old" })]);
  expect(own.libraries[0]!.readOnly).toBeUndefined();
});

it("only the owner deletes footage: a member (an admin account too) never trashes, restores or empties the trash", async () => {
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_m', 'lib_old', 'video', 'Master', 'v_m', 'ana', 0)").run();
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('v_m', 'ast_m', 1, 'k_m', 1, 'h_m', 'ready', 'ana', 0)").run();
  for (const who of ["bo", "bo:admin"]) {
    expect((await call(who, "/api/library/lib_old/assets/ast_m", { method: "DELETE" })).status).toBe(403);
    expect((await call(who, "/api/library/lib_old/trash/empty", { method: "POST" })).status).toBe(404);
    expect((await call(who, "/api/library/lib_old/collections/col_x", { method: "DELETE" })).status).toBe(404);
  }
  expect((d.prepare("SELECT trashed_at FROM assets WHERE id = 'ast_m'").get() as { trashed_at: number | null }).trashed_at).toBeNull();
  expect((await call("ana", "/api/library/lib_old/assets/ast_m", { method: "DELETE" })).status).toBe(200);
  expect((await call("bo:admin", "/api/library/lib_old/assets/ast_m/restore", { method: "POST" })).status).toBe(403);
  expect((await call("ana", "/api/library/lib_old/assets/ast_m/restore", { method: "POST" })).status).toBe(200);
  // the pages hide the Trash and Delete controls from a member (auth.ts sends `member`)
  expect([isTeamMember("bo"), isTeamMember("ana")]).toEqual([true, false]);
});
