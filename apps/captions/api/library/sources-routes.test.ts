import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// "member-b" holds a granted role in lib_a (what a team member will hold once team workspaces land); everyone else is
// whatever access.ts says. The policies must refuse the member on their own, without the role check doing it.
vi.mock("./access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access")>();
  return {
    ...actual,
    libraryRole: (username: string, libraryId: string) =>
      username === "member-b" && libraryId === "lib_a" ? ("member" as never) : actual.libraryRole(username, libraryId),
  };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-sources-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { publicShareApp, shareApp } = await import("./shares");
const { searchApp } = await import("./search");
const { indexAsset } = await import("./query");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");

afterAll(() => {
  resetLibrarySlots();
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", publicShareApp);
app.route("/api/library", libraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);
app.route("/api/library", searchApp);

const call = (user: string | null, method: string, url: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(url, {
    method,
    headers: { ...(user ? { "x-user": user } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

beforeAll(() => {
  const d = libraryDb();
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
  // a Finals piece's version and a plain one, each with its own asset and a ready source file that is not on disk
  const seed = (id: string, title: string, at: number) => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'owner-a', ?)").run(id, title, `${id}-v1`, at);
    d.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'video/mp4', 'ready', 'owner-a', ?)",
    ).run(`${id}-v1`, id, `h-${id}`, at);
    indexAsset(d, id);
  };
  seed("finals-1", "Finals reel", 1000);
  seed("plain-1", "Plain clip", 2000);
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES ('col_finals', 'lib_a', NULL, 'Finals', 'manual', 0)").run();
  d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_finals', 'finals-1', 1, 'owner-a')").run();
  d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES ('pce_1', 'lib_a', 'col_finals', 'Reel', 'owner-a', 0)").run();
  d.prepare("INSERT INTO piece_items (id, piece_id, version_id, position, winner) VALUES ('pci_1', 'pce_1', 'finals-1-v1', 1, 1)").run();
});

describe("a member with a granted role, by default", () => {
  it("lists nothing in the library, and the owner still lists both assets", async () => {
    expect((await json(call("member-b", "GET", "/api/library/lib_a/assets"))).items).toEqual([]);
    const owned = await json(call("owner-a", "GET", "/api/library/lib_a/assets"));
    expect(owned.items.map((i: { id: string }) => i.id).sort()).toEqual(["finals-1", "plain-1"]);
  });

  it("gets 404 on a Finals piece's asset, its media and its search hits", async () => {
    expect((await call("member-b", "GET", "/api/library/lib_a/assets/finals-1")).status).toBe(404);
    expect((await call("member-b", "GET", "/api/library/media/finals-1-v1/thumb")).status).toBe(404);
    expect((await call("member-b", "GET", "/api/library/media/finals-1-v1/play")).status).toBe(404);
    expect(await json(call("member-b", "GET", "/api/library/lib_a/search?q=Finals"))).toEqual([]);
    expect((await call("owner-a", "GET", "/api/library/media/finals-1-v1/play")).status).not.toBe(404);
  });

  it("sees no Finals piece items", async () => {
    const r = await json(call("member-b", "GET", "/api/library/lib_a/pieces?collectionId=col_finals"));
    expect(r.pieces).toEqual([]);
    const own = await json(call("owner-a", "GET", "/api/library/lib_a/pieces?collectionId=col_finals"));
    expect(own.pieces[0].items.map((i: { versionId: string }) => i.versionId)).toEqual(["finals-1-v1"]);
  });

  it("gets 404 when a stranger asks, the same as before", async () => {
    expect((await call("stranger", "GET", "/api/library/lib_a/assets")).status).toBe(404);
  });
});

describe("a share link", () => {
  it("shows its asset to the owner's view, and a member who created the link sees nothing", async () => {
    const made = await json(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "finals-1" }, scope: "view" }));
    const token = made.token as string;
    expect((await json(call(null, "GET", `/api/library/s/${token}`))).items.map((i: { id: string }) => i.id)).toEqual(["finals-1"]);
    // creating a link checks the policies: a member who may not see the asset gets no link at all
    const sharedByMember = await call("member-b", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "finals-1" }, scope: "view" });
    expect(sharedByMember.status).toBe(404);
  });
});

describe("a plug-in facet", () => {
  it("narrows the owner's list and the search by its own SQL, from the f.<key> parameter", async () => {
    registerLibrarySlot("test", {
      facets: [{ key: "safety", where: (vals) => ({ sql: `a.title IN (${vals.map(() => "?").join(",")})`, params: vals }) }],
    });
    const listed = await json(call("owner-a", "GET", "/api/library/lib_a/assets?f.safety=Plain%20clip"));
    expect(listed.items.map((i: { id: string }) => i.id)).toEqual(["plain-1"]);
    const hits = await json(call("owner-a", "GET", "/api/library/lib_a/search?q=clip&f.safety=Plain%20clip"));
    expect(hits.map((h: { asset: { id: string } }) => h.asset.id)).toEqual(["plain-1"]);
    // an unknown facet key is ignored, so the list is the whole library again
    const unknown = await json(call("owner-a", "GET", "/api/library/lib_a/assets?f.nope=x"));
    expect(unknown.items).toHaveLength(2);
    resetLibrarySlots();
  });
});
