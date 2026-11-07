import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-collections-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { publicShareApp, shareApp } = await import("./shares");
const { indexAsset } = await import("./query");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", publicShareApp);
app.route("/api/library", libraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);

const call = async (user: string, method: string, url: string, body?: unknown): Promise<Response> =>
  app.request(url, {
    method,
    headers: { "x-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const data = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

let made = 0;
function seed(id: string, title: string, by: string) {
  const d = libraryDb();
  const at = 2_000_000 + ++made * 1000;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, ?, ?)").run(id, title, `${id}-v1`, by, at);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'ready', ?, ?)",
  ).run(`${id}-v1`, id, `h-${id}`, by, at);
  indexAsset(d, id);
}

const ids = (listing: any) => listing.items.map((i: any) => i.id).sort();

beforeAll(() => {
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          id: "ws_a", name: "a", plan: "team", comped: false, createdAt: 0,
          members: [
            { username: "owner-a", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
            { username: "mem-a", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
            { username: "mem-c", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
          ],
        },
      ],
      invites: [],
      spend: {},
    }),
  );
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0)").run();
  seed("e1", "Alpha reel", "owner-a");
  seed("e2", "Beta reel", "mem-a");
  seed("e3", "Alpha cut", "mem-c");
});

describe("folders and collections", () => {
  it("nests folders, and a folder cannot move inside itself", async () => {
    const parent = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Season 1" }));
    const child = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Cuts", parentId: parent.id }));
    const list = await data(call("owner-a", "GET", "/api/library/lib_a/collections"));
    expect(list.collections.find((c: any) => c.id === child.id).parentId).toBe(parent.id);

    const cycle = await call("owner-a", "PATCH", `/api/library/lib_a/collections/${parent.id}`, { parentId: child.id });
    expect(cycle.status).toBe(409);
  });

  it("holds manual items; a removed folder keeps its items and its folders move up", async () => {
    const f = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Picks" }));
    const sub = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Inside", parentId: f.id }));
    const added = await data(call("owner-a", "POST", `/api/library/lib_a/collections/${f.id}/items`, { assetIds: ["e1", "e2", "missing"] }));
    expect(added).toEqual({ added: 2 });
    expect(ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${f.id}`)))).toEqual(["e1", "e2"]);

    expect(await data(call("owner-a", "DELETE", `/api/library/lib_a/collections/${f.id}/items`, { assetIds: ["e1"] }))).toEqual({ removed: 1 });
    expect(await data(call("owner-a", "DELETE", `/api/library/lib_a/collections/${f.id}`))).toEqual({ ok: true });

    const list = await data(call("owner-a", "GET", "/api/library/lib_a/collections"));
    expect(list.collections.find((c: any) => c.id === sub.id).parentId).toBeNull();
    expect(ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets")))).toContain("e1");
  });

  it("a smart collection runs its saved query, and filters on the request narrow it", async () => {
    const smart = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Alpha", kind: "smart", query: { q: "alpha", limit: 5, trashed: true } }));
    expect(smart.query).toEqual({ q: "alpha" }); // paging and trash are not saved

    expect(ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${smart.id}`)))).toEqual(["e1", "e3"]);
    expect(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${smart.id}&q=cut`))).toMatchObject({ items: [{ id: "e3" }] });
    // a smart collection takes no items of its own
    expect((await call("owner-a", "POST", `/api/library/lib_a/collections/${smart.id}/items`, { assetIds: ["e2"] })).status).toBe(409);
  });

  it("a member edits their own collection; the owner edits any; every member may add items", async () => {
    const mine = await data(call("mem-c", "POST", "/api/library/lib_a/collections", { name: "Mine" }));
    expect((await call("mem-a", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Taken" })).status).toBe(403);
    expect((await call("owner-a", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Owner's" })).status).toBe(200);
    expect((await call("mem-c", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Mine again" })).status).toBe(200);
    expect(await data(call("mem-a", "POST", `/api/library/lib_a/collections/${mine.id}/items`, { assetIds: ["e2"] }))).toEqual({ added: 1 });
  });
});

describe("trash", () => {
  it("a trashed asset leaves the library, shows in the trash, and comes back on restore", async () => {
    seed("t1", "Trash me", "mem-a");
    expect((await call("owner-a", "DELETE", "/api/library/lib_a/assets/t1")).status).toBe(200);

    expect(ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets")))).not.toContain("t1");
    const trash = await data(call("owner-a", "GET", "/api/library/lib_a/assets?trashed=1"));
    expect(trash.items).toMatchObject([{ id: "t1", trashedAt: expect.any(Number) }]);

    expect((await call("owner-a", "POST", "/api/library/lib_a/assets/t1/restore")).status).toBe(200);
    expect(ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets")))).toContain("t1");
  });

  it("only the uploader or the owner moves an asset to or from the trash", async () => {
    seed("t2", "Keep me", "mem-a");
    expect((await call("mem-c", "DELETE", "/api/library/lib_a/assets/t2")).status).toBe(403);
    expect((await call("mem-a", "DELETE", "/api/library/lib_a/assets/t2")).status).toBe(200);
    expect((await call("mem-c", "POST", "/api/library/lib_a/assets/t2/restore")).status).toBe(403);
    expect((await call("owner-a", "POST", "/api/library/lib_a/assets/t2/restore")).status).toBe(200);
  });
});
