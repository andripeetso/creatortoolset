import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-collections-"));
process.env.DATA_DIR = dir;
const { blobs, libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { publicShareApp, shareApp } = await import("./shares");
const { indexAsset } = await import("./query");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");
await import("../work/task-kinds");
// the cover's frame is cut here: the server's video work is on (work/tasks/media-tasks.test.ts has the computer's road)
(await import("../work/server-work")).writeServerWork({ on: true });

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
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', '{\"upload\":\"all\"}', 0)").run();
  seed("e1", "Alpha reel", "owner-a");
  seed("e2", "Beta reel", "owner-a");
  seed("e3", "Alpha cut", "owner-a");
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

  it("takes a selection past 500 whole, and refuses one past the limit out loud instead of cutting it", async () => {
    const many = Array.from({ length: 600 }, (_, i) => `bulk${i}`);
    for (const id of many) seed(id, `Bulk ${id}`, "owner-a");
    const f = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Bulk" }));
    expect(await data(call("owner-a", "POST", `/api/library/lib_a/collections/${f.id}/items`, { assetIds: many }))).toEqual({ added: 600 });
    expect(await data(call("owner-a", "DELETE", `/api/library/lib_a/collections/${f.id}/items`, { assetIds: many }))).toEqual({ removed: 600 });
    const tooMany = Array.from({ length: 5001 }, (_, i) => `x${i}`);
    const r = await call("owner-a", "POST", `/api/library/lib_a/collections/${f.id}/items`, { assetIds: tooMany });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("At most 5000 clips at a time");
    // the next tests count lib_a's clips: these leave again
    const d = libraryDb();
    for (const id of many) {
      d.prepare("DELETE FROM search_assets WHERE asset_id = ?").run(id);
      d.prepare("DELETE FROM asset_versions WHERE asset_id = ?").run(id);
      d.prepare("DELETE FROM assets WHERE id = ?").run(id);
    }
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${f.id}`);
  });

  it("a clip dropped on the A-roll folder is filed A-roll; taken back out it is filed as nothing and sorted again; a photo is never filed", async () => {
    const d = libraryDb();
    seed("r1", "Roll one", "owner-a");
    seed("ph1", "Photo one", "owner-a");
    d.prepare("UPDATE assets SET kind = 'image' WHERE id = 'ph1'").run();
    // a video with sound and no words heard: the sort calls it B-roll (roll.ts)
    d.prepare(`UPDATE asset_versions SET probe = '{"duration":30,"vcodec":"h264","acodec":"aac"}' WHERE id = 'r1-v1'`).run();
    const roll = () => d.prepare("SELECT roll, filed_roll FROM assets WHERE id = 'r1'").get();
    const a = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "A-roll", kind: "smart", query: { roll: "a" } }));
    expect(await data(call("owner-a", "POST", `/api/library/lib_a/collections/${a.id}/items`, { assetIds: ["r1", "ph1"] }))).toEqual({ added: 1 });
    expect(roll()).toEqual({ roll: "a", filed_roll: "a" });
    expect(await data(call("owner-a", "GET", "/api/library/lib_a/counts"))).toMatchObject({ a: 1, image: 1, video: 4 });
    expect(await data(call("owner-a", "POST", `/api/library/lib_a/collections/${a.id}/items`, { assetIds: ["ph1"] }))).toEqual({ added: 0 });
    expect(await data(call("owner-a", "DELETE", `/api/library/lib_a/collections/${a.id}/items`, { assetIds: ["r1"] }))).toEqual({ removed: 1 });
    expect(roll()).toEqual({ roll: "b", filed_roll: null });
    expect(await data(call("owner-a", "GET", "/api/library/lib_a/counts"))).toMatchObject({ a: 0, b: 1 });
    // finished work is not in the Videos tab's list, so not in its count
    d.prepare("UPDATE assets SET filed_roll = 'none' WHERE id = 'r1'").run();
    expect(await data(call("owner-a", "GET", "/api/library/lib_a/counts"))).toMatchObject({ video: 3 });
    // a folder inside the A-roll folder: its clips count as the A-roll's, on the tab and on the folder's card
    seed("r2", "Roll two", "owner-a");
    const inside = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Takes", parentId: a.id }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${inside.id}/items`, { assetIds: ["r2"] });
    expect(await data(call("owner-a", "GET", "/api/library/lib_a/counts"))).toMatchObject({ a: 1 });
    const folders = (await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections as { id: string; count?: number }[];
    expect(folders.find((f) => f.id === a.id)?.count).toBe(1);
    // a plain folder counts the clips in the folders inside it, each once
    const top = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "A-Roll" }));
    const deep = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Apology", parentId: top.id }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${deep.id}/items`, { assetIds: ["r2"] });
    seed("r3", "Roll three", "owner-a");
    const count = async (id: string) => ((await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections as { id: string; count?: number }[]).find((f) => f.id === id)?.count;
    expect(await count(top.id)).toBe(1); // only in the folder inside
    await call("owner-a", "POST", `/api/library/lib_a/collections/${top.id}/items`, { assetIds: ["r2", "r3"] });
    const after = (await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections as { id: string; count?: number }[];
    expect(after.find((f) => f.id === top.id)?.count).toBe(2); // r2 in both: counted once
    expect(after.find((f) => f.id === deep.id)?.count).toBe(1);
    expect((await call("stranger", "GET", "/api/library/lib_a/counts")).status).toBe(404);
  });

  it("a folder deleted moments ago comes back as it was: its id, clips, folders and grants; once only, and never for a stranger", async () => {
    const d = libraryDb();
    const box = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Undo box" }));
    const inner = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Inner", parentId: box.id }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${box.id}/items`, { assetIds: ["e1", "e2"] });
    d.prepare("INSERT INTO library_grants (collection_id, username, granted_by, created_at) VALUES (?, 'friend', 'owner-a', 1)").run(box.id);
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${box.id}`);
    expect((await call("stranger", "POST", `/api/library/lib_a/collections/${box.id}/restore`)).status).toBe(404);
    const back = await data(call("owner-a", "POST", `/api/library/lib_a/collections/${box.id}/restore`));
    expect(back).toMatchObject({ id: box.id, name: "Undo box", parentId: null });
    expect(ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${box.id}`)))).toEqual(["e1", "e2"]);
    const listed = (await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections;
    expect(listed.find((c: any) => c.id === inner.id).parentId).toBe(box.id);
    expect(d.prepare("SELECT username FROM library_grants WHERE collection_id = ?").all(box.id)).toEqual([{ username: "friend" }]);
    expect((await call("owner-a", "POST", `/api/library/lib_a/collections/${box.id}/restore`)).status).toBe(404);
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${inner.id}`);
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${box.id}`);
  });

  it("a smart collection runs its saved query, and filters on the request narrow it", async () => {
    const smart = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Alpha", kind: "smart", query: { q: "alpha", limit: 5, trashed: true } }));
    expect(smart.query).toEqual({ q: "alpha" }); // paging and trash are not saved

    expect(ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${smart.id}`)))).toEqual(["e1", "e3"]);
    expect(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${smart.id}&q=cut`))).toMatchObject({ items: [{ id: "e3" }] });
    // a smart collection takes no items of its own
    expect((await call("owner-a", "POST", `/api/library/lib_a/collections/${smart.id}/items`, { assetIds: ["e2"] })).status).toBe(409);
  });

  it("the Unsorted automatic folder lists the clips in no folder, and keeps doing so as they are filed", async () => {
    const unsorted = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Unsorted", kind: "smart", query: { unfiled: true } }));
    expect(unsorted.query).toEqual({ unfiled: true });
    const listed = async () => ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${unsorted.id}&limit=200`)));
    expect(await listed()).toContain("e2");
    const box = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Box" }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${box.id}/items`, { assetIds: ["e2"] });
    expect(await listed()).not.toContain("e2");
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${box.id}`);
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${unsorted.id}`);
  });

  it("the top level lists the clips in no folder: Finals and a saved search's item rows don't count", async () => {
    const d = libraryDb();
    seed("u1", "Loose one", "owner-a");
    seed("u2", "Filed one", "owner-a");
    seed("u3", "Final one", "owner-a");
    const box = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Box" }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${box.id}/items`, { assetIds: ["u2"] });
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES ('col_fin', 'lib_a', NULL, 'Finals', 'manual', 0)").run();
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_fin', 'u3', 1, 'owner-a')").run();
    const top = ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets?unfiled=1&limit=200")));
    expect(top).toContain("u1");
    expect(top).toContain("u3");
    expect(top).not.toContain("u2");
    d.prepare("DELETE FROM collection_items WHERE collection_id = 'col_fin'").run();
    d.prepare("DELETE FROM collections WHERE id = 'col_fin'").run();
  });

  it("the B-roll folder, renamed, holds its roll: the top level leaves those clips out, its card counts and shows them; a song folder names its songs", async () => {
    const d = libraryDb();
    seed("rb1", "Roll one", "owner-a");
    seed("rb2", "Roll two", "owner-a");
    d.prepare("UPDATE assets SET roll = 'b' WHERE id IN ('rb1', 'rb2')").run();
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key) VALUES ('rb2-v1', 'thumb', 'k')").run();
    const top = async () => ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets?unfiled=1&limit=200")));
    expect(await top()).toContain("rb1"); // no B-roll folder: at the top level
    const b = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "B-roll", kind: "smart", query: { roll: "b" } }));
    await call("owner-a", "PATCH", `/api/library/lib_a/collections/${b.id}`, { name: "Footage" });
    const shown = await top();
    expect(shown).not.toContain("rb1");
    expect(shown).not.toContain("rb2");
    seed("song1", "Theme song", "owner-a");
    d.prepare("UPDATE assets SET kind = 'audio' WHERE id = 'song1'").run();
    const music = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Music" }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${music.id}/items`, { assetIds: ["song1"] });
    const listed = (await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections;
    const footage = listed.find((c: any) => c.id === b.id);
    expect(footage.name).toBe("Footage");
    expect(footage.count).toBeGreaterThanOrEqual(2);
    expect(footage.covers).toContain("/api/library/media/rb2-v1/thumb");
    expect(listed.find((c: any) => c.id === music.id).sounds).toEqual(["Theme song"]);
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${b.id}`);
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${music.id}`);
    expect(await top()).toContain("rb1"); // the folder deleted: back at the top level
  });

  it("a folder's card gets up to four of its clips' pictures; deleting a folder keeps its clips in the library, out of the folder above", async () => {
    const d = libraryDb();
    for (const n of [1, 2, 3, 4, 5]) {
      seed(`pic${n}`, `Picture ${n}`, "owner-a");
      d.prepare("INSERT INTO derivatives (version_id, kind, storage_key) VALUES (?, 'thumb', 'k')").run(`pic${n}-v1`);
    }
    const trip = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Trip" }));
    const day = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Day 1", parentId: trip.id }));
    const inner = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Morning", parentId: day.id }));
    await call("owner-a", "POST", `/api/library/lib_a/collections/${trip.id}/items`, { assetIds: ["pic1", "pic2", "pic3", "pic4", "pic5"] });
    await call("owner-a", "POST", `/api/library/lib_a/collections/${day.id}/items`, { assetIds: ["pic5", "e3"] });
    const listed = (await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections;
    expect(listed.find((c: any) => c.id === trip.id).covers).toEqual(["pic1", "pic2", "pic3", "pic4"].map((p) => `/api/library/media/${p}-v1/thumb`));
    expect(listed.find((c: any) => c.id === day.id).covers).toEqual(["/api/library/media/pic5-v1/thumb"]); // e3 has no picture

    const assets = () => d.prepare("SELECT id, title, trashed_at FROM assets ORDER BY id").all();
    const before = assets();
    // Day 1 (inside Trip) goes: its folder Morning moves up to Trip; its clips are not put in Trip (a share or grant on Trip
    // would then cover them): e3, in no other folder, is at the top level
    expect(await data(call("owner-a", "DELETE", `/api/library/lib_a/collections/${day.id}`))).toEqual({ ok: true });
    expect(ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${trip.id}`)))).toEqual(["pic1", "pic2", "pic3", "pic4", "pic5"]);
    expect(ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets?unfiled=1&limit=200")))).toContain("e3");
    const after = (await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections;
    expect(after.find((c: any) => c.id === inner.id).parentId).toBe(trip.id);
    // Trip (at the top) goes: its clips are at the library's top level, in no folder
    await call("owner-a", "DELETE", `/api/library/lib_a/collections/${trip.id}`);
    const top = ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets?unfiled=1&limit=200")));
    for (const p of ["pic1", "pic2", "pic3", "pic4", "pic5", "e3"]) expect(top).toContain(p);
    expect(assets()).toEqual(before); // no clip deleted, renamed or trashed
  });

  it("the owner renames a collection and adds items; another account gets 404", async () => {
    const mine = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Mine" }));
    expect((await call("stranger", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Taken" })).status).toBe(404);
    expect((await call("owner-a", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Mine again" })).status).toBe(200);
    expect(await data(call("owner-a", "POST", `/api/library/lib_a/collections/${mine.id}/items`, { assetIds: ["e2"] }))).toEqual({ added: 1 });
  });

  it("the owner drags the folders into an order everyone then lists; a new folder goes after them; another account gets 404", async () => {
    const [x, y, z] = [await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Order X" })), await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Order Y" })), await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Order Z" }))];
    const order = async () => ((await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections as { id: string }[]).map((c) => c.id).filter((id) => [x.id, y.id, z.id].includes(id));
    expect((await call("stranger", "PUT", "/api/library/lib_a/collections/order", { ids: [z.id, x.id] })).status).toBe(404);
    expect((await call("owner-a", "PUT", "/api/library/lib_a/collections/order", { ids: "nope" })).status).toBe(400);
    expect((await call("owner-a", "PUT", "/api/library/lib_a/collections/order", { ids: [z.id, x.id, y.id] })).status).toBe(200);
    const w = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Order W" }));
    expect(await order()).toEqual([z.id, x.id, y.id]);
    const all = ((await data(call("owner-a", "GET", "/api/library/lib_a/collections"))).collections as { id: string }[]).map((c) => c.id);
    expect(all.indexOf(w.id)).toBeGreaterThan(all.indexOf(y.id));
  });
});

describe("trash", () => {
  it("a trashed asset leaves the library, shows in the trash, and comes back on restore", async () => {
    seed("t1", "Trash me", "owner-a");
    expect((await call("owner-a", "DELETE", "/api/library/lib_a/assets/t1")).status).toBe(200);

    expect(ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets")))).not.toContain("t1");
    const trash = await data(call("owner-a", "GET", "/api/library/lib_a/assets?trashed=1"));
    expect(trash.items).toMatchObject([{ id: "t1", trashedAt: expect.any(Number) }]);

    expect((await call("owner-a", "POST", "/api/library/lib_a/assets/t1/restore")).status).toBe(200);
    expect(ids(await data(call("owner-a", "GET", "/api/library/lib_a/assets")))).toContain("t1");
  });

  it("only the owner moves an asset to or from the trash", async () => {
    seed("t2", "Keep me", "owner-a");
    expect((await call("stranger", "DELETE", "/api/library/lib_a/assets/t2")).status).toBe(404);
    expect((await call("owner-a", "DELETE", "/api/library/lib_a/assets/t2")).status).toBe(200);
    expect((await call("stranger", "POST", "/api/library/lib_a/assets/t2/restore")).status).toBe(404);
    expect((await call("owner-a", "POST", "/api/library/lib_a/assets/t2/restore")).status).toBe(200);
  });
});

describe("pieces", () => {
  it("a piece with three labelled items and one winner round-trips, and the winner moves", async () => {
    const finals = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Finals" }));
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Roll reel", collectionId: finals.id }));
    expect(p).toMatchObject({ label: "Roll reel", collectionId: finals.id, items: [] });

    let piece: any;
    for (const [versionId, label] of [["e1-v1", "A"], ["e2-v1", "B"], ["e3-v1", "C"]]) {
      piece = await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId, label }));
    }
    expect(piece.items.map((i: any) => [i.label, i.versionId, i.winner])).toEqual([
      ["A", "e1-v1", false],
      ["B", "e2-v1", false],
      ["C", "e3-v1", false],
    ]);

    const [a, b, cItem] = piece.items;
    piece = await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${b.id}`, { winner: true, postDescription: "The good one" }));
    piece = await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${cItem.id}`, { winner: true }));
    expect(piece.items.filter((i: any) => i.winner).map((i: any) => i.label)).toEqual(["C"]);
    expect(piece.items.find((i: any) => i.id === b.id)).toMatchObject({ postDescription: "The good one", winner: false });

    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items/${a.id}/postings`, { platform: "instagram", url: "https://instagram.example/p/1" }));
    const listed = await data(call("owner-a", "GET", `/api/library/lib_a/pieces?collectionId=${finals.id}`));
    expect(listed.pieces).toHaveLength(1);
    expect(listed.pieces[0].items[0].postings).toEqual([
      { id: expect.any(Number), platform: "instagram", url: "https://instagram.example/p/1", postedAt: expect.any(Number), createdBy: "owner-a" },
    ]);
  });

  it("sets a piece's type by hand, back to Automatic with null, and refuses a type it does not know", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Typed" }));
    expect(p.kind).toBeNull();
    expect((await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}`, { kind: "carousel" }))).kind).toBe("carousel");
    // a rename leaves the type as it is
    expect((await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}`, { label: "Typed 2" }))).kind).toBe("carousel");
    expect((await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}`, { kind: null }))).kind).toBeNull();
    expect((await call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}`, { kind: "ad" })).status).toBe(400);
  });

  it("replaces an item's file and keeps its name, post description and postings", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Swap" }));
    let piece = await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "e1-v1", label: "Slide 1" }));
    piece = await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "e2-v1" }));
    const [one, two] = piece.items;
    await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${one.id}`, { postDescription: "Kept" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items/${one.id}/postings`, { platform: "instagram" }));
    piece = await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${one.id}`, { versionId: "e3-v1" }));
    expect(piece.items[0]).toMatchObject({ id: one.id, versionId: "e3-v1", label: "Slide 1", postDescription: "Kept", postings: [expect.objectContaining({ platform: "instagram" })] });
    // a version the piece holds already, or one not in this library, is refused
    expect((await call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${one.id}`, { versionId: two.versionId })).status).toBe(409);
    expect((await call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${one.id}`, { versionId: "nope" })).status).toBe(404);
  });

  it("the database keeps one winner per piece, and a version is in a piece once", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Solo" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "e1-v1" }));
    expect((await call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "e1-v1" })).status).toBe(409);
    expect(() =>
      libraryDb().prepare("INSERT INTO piece_items (id, piece_id, version_id, position, winner) VALUES ('pci_x', ?, 'e2-v1', 9, 1)").run(p.id),
    ).not.toThrow();
    expect(() =>
      libraryDb().prepare("INSERT INTO piece_items (id, piece_id, version_id, position, winner) VALUES ('pci_y', ?, 'e3-v1', 9, 1)").run(p.id),
    ).toThrow();
    // an item needs exactly one of a version and an external ref
    expect(() => libraryDb().prepare("INSERT INTO piece_items (id, piece_id, position) VALUES ('pci_z', ?, 1)").run(p.id)).toThrow();
  });

  it("a version that is not live in this library is 404; trashing hides the item; deleting the version removes it", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Gone" }));
    expect((await call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "nope-v1" })).status).toBe(404);

    seed("p1", "Piece one", "owner-a");
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "p1-v1" }));
    await call("owner-a", "DELETE", "/api/library/lib_a/assets/p1");
    expect((await data(call("owner-a", "GET", "/api/library/lib_a/pieces"))).pieces.find((x: any) => x.id === p.id).items).toEqual([]);
    await call("owner-a", "POST", "/api/library/lib_a/assets/p1/restore");

    libraryDb().prepare("DELETE FROM asset_versions WHERE id = 'p1-v1'").run(); // what the trash purge does
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM piece_items WHERE piece_id = ?").get(p.id)).toEqual({ n: 0 });
  });

  it("deleting a collection leaves its pieces without one", async () => {
    const f = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Temp" }));
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Kept", collectionId: f.id }));
    expect(await data(call("owner-a", "DELETE", `/api/library/lib_a/collections/${f.id}`))).toEqual({ ok: true });
    expect(await data(call("owner-a", "GET", `/api/library/lib_a/pieces`))).toMatchObject({ pieces: expect.arrayContaining([expect.objectContaining({ id: p.id, collectionId: null })]) });
  });

  it("another account gets 404 on pieces, and a posting link must be http or https", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Mine" }));
    expect((await call("stranger", "GET", "/api/library/lib_a/pieces")).status).toBe(404);
    expect((await call("stranger", "DELETE", `/api/library/lib_a/pieces/${p.id}`)).status).toBe(404);
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "e2-v1" }));
    const piece = await data(call("owner-a", "GET", `/api/library/lib_a/pieces`));
    const item = piece.pieces.find((x: any) => x.id === p.id).items[0];
    expect((await call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items/${item.id}/postings`, { platform: "tiktok", url: "javascript:alert(1)" })).status).toBe(400);
  });

  it("one piece reads back with writable set; a stranger gets 404", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Single" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "e3-v1" }));
    expect(await data(call("owner-a", "GET", `/api/library/lib_a/pieces/${p.id}`))).toMatchObject({
      id: p.id,
      label: "Single",
      writable: true,
      items: [{ versionId: "e3-v1" }],
    });
    expect((await call("stranger", "GET", `/api/library/lib_a/pieces/${p.id}`)).status).toBe(404);
    expect((await call("owner-a", "GET", "/api/library/lib_a/pieces/pce_nope")).status).toBe(404);
  });
});

describe("piece cover", () => {
  const key = "libraries/lib_a/v/cov-v1/source";
  const clip = path.join(dir, "cover-clip.mp4");

  beforeAll(async () => {
    // a real one-second clip as the version's source, so the frame is cut by ffmpeg the way the server does it
    execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    seed("cov", "Cover clip", "owner-a");
    libraryDb().prepare("UPDATE asset_versions SET source_key = ? WHERE id = 'cov-v1'").run(key);
    await blobs.put(key, clip);
  });

  it("the owner picks a frame of a version; a viewer who sees it gets the JPEG; a stranger gets 404; clearing it goes back to automatic", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Covered" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "cov-v1" }));
    const url = `/api/library/lib_a/pieces/${p.id}/cover`;

    const picked = await data(call("owner-a", "POST", url, { versionId: "cov-v1", t: 0 }));
    expect(picked.coverUrl).toMatch(new RegExp(`^/api/library/lib_a/pieces/${p.id}/cover\\?v=\\d+$`));
    const shown = await call("owner-a", "GET", picked.coverUrl);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/jpeg");
    expect((await call("stranger", "GET", url)).status).toBe(404);
    expect((await data(call("owner-a", "GET", `/api/library/lib_a/pieces/${p.id}`))).coverUrl).toBe(picked.coverUrl);

    expect((await call("owner-a", "POST", url, { versionId: "e2-v1", t: 0 })).status).toBe(404); // not an item of this piece
    expect((await call("owner-a", "POST", url, { versionId: "cov-v1", t: -1 })).status).toBe(400);
    expect((await call("stranger", "POST", url, { versionId: "cov-v1", t: 0 })).status).toBe(404);

    const cleared = await data(call("owner-a", "DELETE", url));
    expect(cleared.coverUrl).toBeNull();
    expect((await call("owner-a", "GET", url)).status).toBe(404);
  });

  it("removing the cover's version from the piece clears the cover too", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Uncovered" }));
    const withItem = await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "cov-v1" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/cover`, { versionId: "cov-v1", t: 0 }));
    const after = await data(call("owner-a", "DELETE", `/api/library/lib_a/pieces/${p.id}/items/${withItem.items[0].id}`));
    expect(after.coverUrl).toBeNull();
  });
});

describe("piece zip (Save all)", () => {
  beforeAll(async () => {
    seed("zip1", "Zip one", "owner-a");
    seed("zip2", "Zip two", "owner-a");
    for (const [id, text] of [
      ["zip1", "first take bytes"],
      ["zip2", "second take bytes"],
    ] as const) {
      const key = `libraries/lib_a/v/${id}-v1/source`;
      const file = path.join(dir, `${id}.mp4`);
      writeFileSync(file, text);
      libraryDb().prepare("UPDATE asset_versions SET source_key = ?, mime = 'video/mp4' WHERE id = ?").run(key, `${id}-v1`);
      await blobs.put(key, file);
    }
  });

  const zipOf = async (user: string, pid: string) => {
    const r = await call(user, "GET", `/api/library/lib_a/pieces/${pid}/zip`);
    return { status: r.status, type: r.headers.get("content-type"), text: Buffer.from(await r.arrayBuffer()).toString("latin1") };
  };

  it("the visible versions as one ZIP in drag order, each with its source file; a stranger gets 404", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Zip reel" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "zip1-v1", label: "Hook" }));
    const both = await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "zip2-v1" }));
    await data(call("owner-a", "PATCH", `/api/library/lib_a/pieces/${p.id}/items/${both.items[1].id}`, { position: 0 }));

    const zip = await zipOf("owner-a", p.id);
    expect(zip.status).toBe(200);
    expect(zip.type).toBe("application/zip");
    expect(zip.text.startsWith("PK\u0003\u0004")).toBe(true);
    expect(zip.text).toContain("01-Zip_two.mp4");
    expect(zip.text).toContain("02-Hook.mp4");
    expect(zip.text.indexOf("second take bytes")).toBeLessThan(zip.text.indexOf("first take bytes"));
    expect((await zipOf("stranger", p.id)).status).toBe(404);
  });

  it("a version the policies hide is left out of the ZIP", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Hidden one" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "zip1-v1" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "zip2-v1" }));
    registerLibrarySlot("test", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "zip2" }] });
    try {
      const zip = await zipOf("owner-a", p.id);
      expect(zip.status).toBe(200);
      expect(zip.text).toContain("first take bytes");
      expect(zip.text).not.toContain("second take bytes");
    } finally {
      resetLibrarySlots();
    }
  });

  it("a piece none of whose versions the viewer may see gets 404, not an empty ZIP", async () => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label: "Only hidden" }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId: "zip2-v1" }));
    registerLibrarySlot("test", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "zip2" }] });
    try {
      expect((await zipOf("owner-a", p.id)).status).toBe(404);
    } finally {
      resetLibrarySlots();
    }
  });
});

describe("piece merge and the Finals folder", () => {
  beforeAll(() => {
    for (const id of ["m1", "m2", "m3", "m4"]) seed(id, `Merge ${id}`, "owner-a");
  });

  const pieceWith = async (label: string, versionId: string) => {
    const p = await data(call("owner-a", "POST", "/api/library/lib_a/pieces", { label }));
    await data(call("owner-a", "POST", `/api/library/lib_a/pieces/${p.id}/items`, { versionId, label }));
    return p;
  };
  const merge = (into: { id: string }, from: { id: string }) =>
    call("owner-a", "POST", `/api/library/lib_a/pieces/${into.id}/merge`, { from: from.id });

  it("a merged piece cannot merge again, and nothing merges into a trashed piece: the Undo record keeps where it went", async () => {
    const p1 = await pieceWith("Merge P1", "m1-v1");
    const p2 = await pieceWith("Merge P2", "m2-v1");
    const p3 = await pieceWith("Merge P3", "m3-v1");
    const p4 = await pieceWith("Merge P4", "m4-v1");
    expect((await merge(p2, p1)).status).toBe(200);
    expect((await merge(p3, p1)).status).toBe(409);
    const trash = await data(call("owner-a", "GET", "/api/library/lib_a/pieces?trash=1"));
    expect(trash.pieces.find((p: any) => p.id === p1.id).merged).toEqual({ into: "Merge P2", versions: 1 });

    expect((await call("owner-a", "POST", `/api/library/lib_a/pieces/${p3.id}/trash`)).status).toBe(200);
    expect((await merge(p3, p4)).status).toBe(409);
    const live = await data(call("owner-a", "GET", "/api/library/lib_a/pieces"));
    expect(live.pieces.find((p: any) => p.id === p4.id).items).toHaveLength(1);
  });

  it("the Finals folder cannot be deleted: 409, and it is still listed", async () => {
    const f = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Finals" }));
    expect((await call("owner-a", "DELETE", `/api/library/lib_a/collections/${f.id}`)).status).toBe(409);
    const list = await data(call("owner-a", "GET", "/api/library/lib_a/collections"));
    expect(list.collections.some((c: any) => c.id === f.id)).toBe(true);
  });
});
