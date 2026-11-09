import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-pieces-ops-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { collectionApp } = await import("./collections");
const { indexAsset } = await import("./query");
const { finalsLinkedTo, linkFinalsPiece } = await import("./finals");
const { onEvent } = await import("../lib/events");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", collectionApp);

const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { "x-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const data = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();

function seedVideo(id: string) {
  const d = libraryDb();
  const at = 2_000_000;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'owner-a', ?)").run(id, id, `${id}-v1`, at);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'ready', 'owner-a', ?)",
  ).run(`${id}-v1`, id, `h-${id}`, at);
  indexAsset(d, id);
}

function seedPiece(id: string, label: string, versions: string[]) {
  const d = libraryDb();
  d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES (?, 'lib_a', NULL, ?, 'owner-a', ?)").run(id, label, 1);
  versions.forEach((v, i) => {
    d.prepare("INSERT INTO piece_items (id, piece_id, version_id, label, position) VALUES (?, ?, ?, ?, ?)").run(`${id}-i${i}`, id, `${v}-v1`, v, i + 1);
  });
}

for (const v of ["m1", "m2", "m3", "m4", "s1", "s2"]) seedVideo(v);
seedPiece("pc_target", "Target", ["m1", "m2"]);
seedPiece("pc_source", "Source", ["m3"]);
seedPiece("pc_clash", "Clash", ["m2"]);
seedPiece("pc_split", "Split", ["m4", "s1"]);
seedPiece("pc_trash", "Trash", ["s2"]);
seedPiece("pc_link", "Link", ["s1"]);

describe("Finals pieces: merge, split, trash", () => {
  it("merge moves the other piece's items in and removes it", async () => {
    const merged = await data(call("owner-a", "POST", "/api/library/lib_a/pieces/pc_target/merge", { from: "pc_source" }));
    expect(merged.items.map((i: any) => i.versionId)).toEqual(expect.arrayContaining(["m1-v1", "m2-v1", "m3-v1"]));
    expect(merged.items.length).toBe(3);
    const list = await data(call("owner-a", "GET", "/api/library/lib_a/pieces"));
    expect(list.pieces.map((p: any) => p.id)).not.toContain("pc_source");
  });

  it("merge refuses when both pieces hold the same version (409, nothing moves)", async () => {
    const r = await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_target/merge", { from: "pc_clash" });
    expect(r.status).toBe(409);
    const list = await data(call("owner-a", "GET", "/api/library/lib_a/pieces"));
    expect(list.pieces.map((p: any) => p.id)).toContain("pc_clash");
  });

  it("split takes one item out into a piece of its own", async () => {
    const made = await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_split/items/pc_split-i1/split");
    expect(made.status).toBe(201);
    const piece: any = await made.json();
    expect(piece.items.length).toBe(1);
    const left = await data(call("owner-a", "GET", "/api/library/lib_a/pieces"));
    const origin = left.pieces.find((p: any) => p.id === "pc_split");
    expect(origin.items.length).toBe(1);
  });

  it("trash hides a piece from the list; the trash lists it; restore brings it back", async () => {
    expect((await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_trash/trash")).status).toBe(200);
    const live = await data(call("owner-a", "GET", "/api/library/lib_a/pieces"));
    expect(live.pieces.map((p: any) => p.id)).not.toContain("pc_trash");
    const trashed = await data(call("owner-a", "GET", "/api/library/lib_a/pieces?trash=1"));
    expect(trashed.pieces.map((p: any) => p.id)).toEqual(["pc_trash"]);
    expect((await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_trash/restore")).status).toBe(200);
    const back = await data(call("owner-a", "GET", "/api/library/lib_a/pieces"));
    expect(back.pieces.map((p: any) => p.id)).toContain("pc_trash");
  });

  it("a change tells the library listeners once", async () => {
    let told = 0;
    const stop = onEvent("library.changed", () => void told++);
    await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_trash/trash");
    await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_trash/restore");
    await call("owner-a", "GET", "/api/library/lib_a/pieces");
    stop();
    expect(told).toBe(2);
  });

  it("a piece links to a session of its owner; its versions are the session's Finals", () => {
    expect(linkFinalsPiece("pc_link", "sess-1", undefined, "someone-else")).toBe(false);
    expect(linkFinalsPiece("pc_link", "sess-1", undefined, "owner-a")).toBe(true);
    const versions = finalsLinkedTo("sess-1", "doc-main", "doc-main");
    expect(versions).toEqual([{ key: "pc_link-i0", label: "Link · s1", facts: "file s1, video, version 1" }]);
    expect(finalsLinkedTo("sess-1", "doc-other", "doc-main")).toEqual([]);
  });

  it("a trashed piece's versions leave the session's Finals", async () => {
    await call("owner-a", "POST", "/api/library/lib_a/pieces/pc_link/trash");
    expect(finalsLinkedTo("sess-1", "doc-main", "doc-main")).toEqual([]);
  });
});
