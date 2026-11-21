import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A workspace's library is its owner's, for every member: a member who opens a given workspace before its owner does
// never makes one in their own home, so the owner then finds the same library, with what was put in it.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-given-first-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIRST = "cccccccc-0000-4000-8000-000000000001";
const SECOND = "cccccccc-0000-4000-8000-000000000002";
const projects = path.join(dir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
for (const [id, at] of [[FIRST, 1], [SECOND, 2]] as const) {
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
}
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "t", name: "Team", plan: "team", comped: false, createdAt: 0,
        members: [
          { username: "ana", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "bo", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: [FIRST, SECOND] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);

const { libraryDb } = await import("./db");
const { ensureLibrary, librariesHere, libraryRole, mediaReady } = await import("./access");
const { libraryApp } = await import("./routes");
const { inRequestWorkspace } = await import("../lib/workspace-scope");

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-test-user"), role: "user", off: [], read: [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", libraryApp);

it("a member opening a given workspace first makes the owner's library, and the owner sees it with its files", async () => {
  // the member first (a chat drop, an export, a folder of theirs): the library goes to ana's home, tagged with SECOND
  const id = await ensureLibrary("bo", SECOND);
  expect(id).toBeTruthy();
  expect(libraryDb().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(id)).toEqual({ workspace_id: "t" });
  expect(await ensureLibrary("bo", SECOND)).toBe(id);
  expect(libraryRole("bo", id!)).toBeNull();
  libraryDb()
    .prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_roll', ?, 'video', 'Roll', 'v_roll', 'bo', 0)")
    .run(id);

  // every lookup agrees on it, for the owner and the member
  expect(await ensureLibrary("ana", SECOND)).toBe(id);
  expect((await librariesHere("ana", SECOND)).map((l) => l.id)).toEqual([id]);
  expect((await librariesHere("bo", SECOND)).map((l) => l.id)).toEqual([id]);
  expect(await mediaReady("ana", SECOND)).toMatchObject({ owner: true, libraryId: id });
  expect(await mediaReady("bo", SECOND)).toMatchObject({ owner: false, libraryId: id });
  expect(libraryRole("ana", id!)).toBe("owner");

  // the owner's Media Library in that workspace lists it, with the member's file
  const listed = (await (await app.request("/api/library", { headers: { "x-test-user": "ana", "x-ct-workspace": SECOND } })).json()) as { libraries: { id: string }[] };
  expect(listed.libraries.map((l) => l.id)).toEqual([id]);
  const n = libraryDb().prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(id) as { n: number };
  expect(n.n).toBe(1);
  // no library was made in the member's own home
  expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM libraries WHERE workspace_id = 'bo'").get()).toEqual({ n: 0 });
});

it("the first brand's library from before workspaces is the one mediaReady reads, as a folder's scan fills it", async () => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_old', 't', 'Old', 'local', ?, 0)").run(JSON.stringify({ setupAt: "2026-11-19T10:00:00.000Z" }));
  expect(await ensureLibrary("ana", FIRST)).toBe("lib_old");
  expect(await mediaReady("ana", FIRST)).toEqual({ ready: true, owner: true, libraryId: "lib_old" });
  expect(await mediaReady("bo", FIRST)).toEqual({ ready: true, owner: false, libraryId: "lib_old" });
});
