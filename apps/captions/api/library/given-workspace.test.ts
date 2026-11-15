import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A member the team's owner gave one of their workspaces (Settings → Team → Access) sees the owner's library there and
// opens it, read-only: no other workspace's library, and nothing they write reaches it.
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

// ana's libraries carry her team's id (homeOf, access.ts). lib_old is from before workspaces, so the first brand's; lib_two is the second's
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_old', 't', 'Old', 'local', 0)").run();
libraryDb().prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_two', 't', 'Two', 'local', '{"projectId":"${SECOND}"}', 1)`).run();

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-test-user") ?? "", role: "user", off: [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", collectionApp);
app.route("/api/library", libraryApp);

const call = (user: string, url: string, init: RequestInit = {}, ws?: string) =>
  app.request(url, { ...init, headers: { "x-test-user": user, "content-type": "application/json", ...(ws ? { "x-ct-workspace": ws } : {}) } });

it("lists and opens the owner's library in the given workspace only, read-only", async () => {
  const listed = (await (await call("bo", "/api/library", {}, FIRST)).json()) as { libraries: { id: string; readOnly?: boolean }[] };
  expect(listed.libraries).toEqual([expect.objectContaining({ id: "lib_old", readOnly: true })]);
  expect((await call("bo", "/api/library/lib_old/assets")).status).toBe(200);
  expect((await call("bo", "/api/library/lib_old/collections")).status).toBe(200);
  expect((await call("bo", "/api/library/lib_two/assets")).status).toBe(404);
  expect((await call("cy", "/api/library/lib_old/assets")).status).toBe(404);
  // writes ask whose library it is: never the member's
  expect((await call("bo", "/api/library/lib_old", { method: "PATCH", body: JSON.stringify({ name: "Mine" }) })).status).toBe(404);
  expect((await call("bo", "/api/library/lib_old/uploads/check", { method: "POST", body: JSON.stringify({ files: [] }) })).status).toBe(404);
  // the owner's own view is as before
  const own = (await (await call("ana", "/api/library", {}, FIRST)).json()) as { libraries: { id: string; readOnly?: boolean }[] };
  expect(own.libraries).toEqual([expect.objectContaining({ id: "lib_old" })]);
  expect(own.libraries[0]!.readOnly).toBeUndefined();
});
