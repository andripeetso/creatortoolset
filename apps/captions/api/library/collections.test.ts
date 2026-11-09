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
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
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

  it("a smart collection runs its saved query, and filters on the request narrow it", async () => {
    const smart = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Alpha", kind: "smart", query: { q: "alpha", limit: 5, trashed: true } }));
    expect(smart.query).toEqual({ q: "alpha" }); // paging and trash are not saved

    expect(ids(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${smart.id}`)))).toEqual(["e1", "e3"]);
    expect(await data(call("owner-a", "GET", `/api/library/lib_a/assets?collectionId=${smart.id}&q=cut`))).toMatchObject({ items: [{ id: "e3" }] });
    // a smart collection takes no items of its own
    expect((await call("owner-a", "POST", `/api/library/lib_a/collections/${smart.id}/items`, { assetIds: ["e2"] })).status).toBe(409);
  });

  it("the owner renames a collection and adds items; another account gets 404", async () => {
    const mine = await data(call("owner-a", "POST", "/api/library/lib_a/collections", { name: "Mine" }));
    expect((await call("stranger", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Taken" })).status).toBe(404);
    expect((await call("owner-a", "PATCH", `/api/library/lib_a/collections/${mine.id}`, { name: "Mine again" })).status).toBe(200);
    expect(await data(call("owner-a", "POST", `/api/library/lib_a/collections/${mine.id}/items`, { assetIds: ["e2"] }))).toEqual({ added: 1 });
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
