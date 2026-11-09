import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-shares-"));
process.env.DATA_DIR = dir;
const { libraryDb, blobs } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { publicShareApp, shareApp } = await import("./shares");
const { indexAsset } = await import("./query");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the account is named in x-user; boot.ts sets the same user before these routes
const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", publicShareApp);
app.route("/api/library", libraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const call = async (user: string, method: string, url: string, body?: unknown): Promise<Response> =>
  app.request(url, {
    method,
    headers: { "x-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const data = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

/** One asset with one ready version, straight into the database (no upload, no ffmpeg). Returns the version id. */
let made = 0;
function seed(id: string, title: string, by: string, library = "lib_a"): string {
  const d = libraryDb();
  const at = 1_000_000 + ++made * 1000;
  const v = `${id}-v1`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', ?, ?, ?, ?)").run(id, library, title, v, by, at);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, ?, 4, ?, 'video/mp4', 'ready', ?, ?)",
  ).run(v, id, `libraries/${library}/v/${v}/source`, sha256(id), by, at);
  indexAsset(d, id);
  return v;
}

/** The file a version's source points at, so a media request has bytes to stream. */
async function putSource(versionId: string, library = "lib_a") {
  const file = path.join(dir, `${versionId}.src`);
  writeFileSync(file, "fake-video-bytes");
  await blobs.put(`libraries/${library}/v/${versionId}/source`, file);
}

beforeAll(async () => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0), ('lib_b', 'owner-b', 'B', 'local', 0)").run();
});

describe("library share links", () => {
  it("stores the token and the password only as hashes", async () => {
    seed("a1", "Alpha", "owner-a");
    const made = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "a1" }, scope: "view", password: "open-sesame-1" }));
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.id).toBe(sha256(made.token));
    const rows = JSON.stringify(libraryDb().prepare("SELECT * FROM shares").all());
    expect(rows).not.toContain(made.token);
    expect(rows).not.toContain("open-sesame-1");
  });

  it("answers an expired link and a revoked link with 404", async () => {
    const v = seed("a2", "Beta", "owner-a");
    await putSource(v);
    const live = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "a2" }, scope: "view" }));
    expect((await call("", "GET", `/api/library/s/${live.token}`)).status).toBe(200);

    libraryDb().prepare("UPDATE shares SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1, live.id);
    expect((await call("", "GET", `/api/library/s/${live.token}`)).status).toBe(404);

    const revoked = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "a2" }, scope: "view" }));
    // another account may not revoke it
    expect((await call("stranger", "DELETE", `/api/library/shares/${revoked.id}`)).status).toBe(404);
    expect((await call("owner-a", "DELETE", `/api/library/shares/${revoked.id}`)).status).toBe(200);
    expect((await call("", "GET", `/api/library/s/${revoked.token}`)).status).toBe(404);
    expect((await call("", "GET", `/api/library/s/${revoked.token}/media/${v}/play`)).status).toBe(404);
  });

  it("locks a link behind its password: no items and no media until the unlock cookie", async () => {
    const v = seed("a3", "Gamma", "owner-a");
    await putSource(v);
    const made = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "a3" }, scope: "download", password: "open-sesame-1" }));

    const locked = await data(call("", "GET", `/api/library/s/${made.token}`));
    expect(locked).toEqual({ locked: true, items: [] });
    expect((await call("", "GET", `/api/library/s/${made.token}/media/${v}/play`)).status).toBe(404);
    expect((await call("", "POST", `/api/library/s/${made.token}/unlock`, { password: "nope" })).status).toBe(403);

    const unlock = await call("", "POST", `/api/library/s/${made.token}/unlock`, { password: "open-sesame-1" });
    expect(unlock.status).toBe(204);
    const cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;

    const open = await data(app.request(`/api/library/s/${made.token}`, { headers: { cookie } }));
    expect(open).toMatchObject({ locked: false, name: "Gamma", scope: "download", items: [{ id: "a3", versionId: v }] });
    expect(open.items[0].sourceUrl).toBe(`/api/library/s/${made.token}/media/${v}/source`);
    const media = await app.request(`/api/library/s/${made.token}/media/${v}/source`, { headers: { cookie } });
    expect(media.status).toBe(200);
    expect(await media.text()).toBe("fake-video-bytes");
  });

  it("stops guessing a link's password after 10 wrong tries, right or wrong, until the window ends", async () => {
    seed("a4", "Delta", "owner-a");
    const made = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "a4" }, scope: "view", password: "open-sesame-2" }));
    for (let i = 0; i < 10; i++) {
      expect((await call("", "POST", `/api/library/s/${made.token}/unlock`, { password: `guess-${i}` })).status).toBe(403);
    }
    expect((await call("", "POST", `/api/library/s/${made.token}/unlock`, { password: "open-sesame-2" })).status).toBe(429);
  });

  it("a share never lists another asset: one asset, one version, or only a collection's members", async () => {
    const va = seed("b1", "Alpha two", "owner-a");
    seed("b2", "Beta two", "owner-a");
    const col = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Picks" }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${col.id}/items`, { assetIds: ["b2"] });

    const asset = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "b1" }, scope: "view" }));
    expect((await data(call("", "GET", `/api/library/s/${asset.token}`))).items.map((i: any) => i.id)).toEqual(["b1"]);

    const version = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "version", id: va }, scope: "view" }));
    expect((await data(call("", "GET", `/api/library/s/${version.token}`))).items.map((i: any) => i.id)).toEqual(["b1"]);

    const folder = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "collection", id: col.id }, scope: "view" }));
    const view = await data(call("", "GET", `/api/library/s/${folder.token}`));
    expect(view.items.map((i: any) => i.id)).toEqual(["b2"]);
    // a view link has no original, and the original of an asset outside the link is 404
    expect(view.items[0].sourceUrl).toBeUndefined();
    expect((await call("", "GET", `/api/library/s/${folder.token}/media/${va}/play`)).status).toBe(404);
  });

  it("a non-member gets 404 on every route, the new ones included", async () => {
    const v = seed("c1", "Delta", "owner-a");
    const link = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "c1" }, scope: "view" }));
    const col = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Mine" }));
    const routes: [string, string, unknown?][] = [
      ["POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "c1" }, scope: "view" }],
      ["GET", "/api/library/lib_a/shares"],
      ["DELETE", `/api/library/shares/${link.id}`],
      ["GET", "/api/library/lib_a/collections"],
      ["POST", "/api/library/lib_a/collections", { name: "x" }],
      ["PATCH", `/api/library/lib_a/collections/${col.id}`, { name: "y" }],
      ["DELETE", `/api/library/lib_a/collections/${col.id}`],
      ["POST", `/api/library/lib_a/collections/${col.id}/items`, { assetIds: ["c1"] }],
      ["DELETE", `/api/library/lib_a/collections/${col.id}/items`, { assetIds: ["c1"] }],
      ["DELETE", "/api/library/lib_a/assets/c1"],
      ["POST", "/api/library/lib_a/assets/c1/restore"],
      ["GET", "/api/library/lib_a/assets"],
      ["GET", `/api/library/media/${v}/play`],
    ];
    for (const [method, url, body] of routes) {
      expect([method, url, (await call("owner-b", method, url, body)).status]).toEqual([method, url, 404]);
    }
  });
});

describe("piece shares and the policies on writes", () => {
  it("a link stops showing an asset the policies hide after the link was made", async () => {
    seed("late1", "Late", "owner-a");
    const made = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "late1" }, scope: "view" }));
    expect((await data(call("", "GET", `/api/library/s/${made.token}`))).items.map((i: any) => i.id)).toEqual(["late1"]);
    registerLibrarySlot("test-late", { policies: [{ sourceId: "library", canSee: (_viewer, asset) => asset.assetId !== "late1" }] });
    try {
      expect((await data(call("", "GET", `/api/library/s/${made.token}`))).items).toEqual([]);
    } finally {
      resetLibrarySlots();
    }
  });

  it("a piece link shows the piece's versions in order, under the piece's label", async () => {
    seed("p1", "Piece one", "owner-a");
    seed("p2", "Piece two", "owner-a");
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Roll reel" }));
    await call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "p2-v1" });
    await call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "p1-v1" });
    const share = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "piece", id: p.id }, scope: "view" }));
    const view = await data(call("", "GET", `/api/library/s/${share.token}`));
    expect(view).toMatchObject({ name: "Roll reel", locked: false, items: [{ id: "p2" }, { id: "p1" }] });
  });

  it("the policies hold for writes: a hidden asset cannot be shared, filed, trashed or edited, and a piece holding one is refused", async () => {
    seed("hid1", "Hidden", "owner-a");
    seed("pub1", "Public", "owner-a");
    const hiddenPiece = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Has hidden" }));
    await call("owner-a", "POST", `/api/library/lib_a/pieces/${hiddenPiece.id}/items`, { versionId: "hid1-v1" });
    const piece = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Public only" }));
    await call("owner-a", "POST", `/api/library/lib_a/pieces/${piece.id}/items`, { versionId: "pub1-v1" });
    const col = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Mixed set" }));

    registerLibrarySlot("test-hide", { policies: [{ sourceId: "library", canSee: (_viewer, asset) => asset.assetId !== "hid1" }] });
    try {
      expect((await call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "asset", id: "hid1" }, scope: "view" })).status).toBe(404);
      expect((await call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "piece", id: hiddenPiece.id }, scope: "view" })).status).toBe(404);
      expect((await call("owner-a", "POST", `/api/library/lib_a/pieces/${piece.id}/items`, { versionId: "hid1-v1" })).status).toBe(404);
      expect((await call("owner-a", "PATCH", `/api/library/lib_a/pieces/${hiddenPiece.id}`, { label: "Renamed" })).status).toBe(404);
      expect((await call("owner-a", "PATCH", `/api/library/lib_a/pieces/${piece.id}`, { label: "Renamed" })).status).toBe(200);
      expect((await call("owner-a", "DELETE", "/api/library/lib_a/assets/hid1")).status).toBe(404);
      expect(await data(call("owner-a", "POST", `/api/library/lib_a/collections/${col.id}/items`, { assetIds: ["hid1", "pub1"] }))).toEqual({ added: 1 });

      const share = await data(call("owner-a", "POST", "/api/library/lib_a/shares", { target: { kind: "collection", id: col.id }, scope: "view" }));
      expect((await data(call("", "GET", `/api/library/s/${share.token}`))).items.map((i: any) => i.id)).toEqual(["pub1"]);
    } finally {
      resetLibrarySlots();
    }
  });
});
