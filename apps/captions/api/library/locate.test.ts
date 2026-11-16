import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-locate-"));
process.env.DATA_DIR = dir;
const { blobs, libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { backfillQuick } = await import("./locate");
const { quickPrint } = await import("../work/files");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
const call = (method: string, url: string, body?: unknown, user = "owner-a") =>
  Promise.resolve(
    app.request(url, { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }),
  );

const q = (c: string) => c.repeat(64);
const versionOf = (id: string) => libraryDb().prepare("SELECT mac_path, mac_device, source_path, quick FROM asset_versions WHERE id = ?").get(id) as Record<string, string | null>;

beforeAll(() => {
  const d = libraryDb();
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
  const add = (id: string, by: string, o: { bytes: number; quick: string | null; mac?: string; device?: string; source?: string; state?: string; key?: string }) => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 0)").run(`a_${id}`, id, by);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, state, created_by, created_at, mac_path, mac_device, quick)
       VALUES (?, ?, 1, ?, ?, ?, 'x', ?, ?, 0, ?, ?, ?)`,
    ).run(id, `a_${id}`, o.key ?? (o.mac ? `mac:${id}` : `libraries/lib_a/v/${id}/source.mov`), o.source ?? null, o.bytes, o.state ?? "ready", by, o.mac ?? null, o.device ?? null, o.quick);
  };
  // the owner's clips on their Mac, moved to /Volumes/New/Footage: one asked, two more gone, one still where it was
  add("asked", "owner-a", { bytes: 100, quick: q("1"), mac: "/Volumes/Old/Footage/a.mov", device: "mac_1" });
  add("gone2", "owner-a", { bytes: 200, quick: q("2"), mac: "/Volumes/Old/Footage/b.mov", device: "mac_1" });
  add("gone3", "owner-a", { bytes: 300, quick: q("3"), mac: "/Volumes/Old/Footage/c.mov", device: "mac_1" });
  add("there", "owner-a", { bytes: 400, quick: q("4"), mac: "/Users/a/kept.mov", device: "mac_1" });
  add("same-size", "owner-a", { bytes: 500, quick: q("5"), mac: "/Volumes/Old/Footage/e.mov", device: "mac_1" });
  add("elsewhere", "owner-a", { bytes: 600, quick: q("6"), mac: "/Users/a/f.mov", device: "mac_2" });
  // a member's own clip in the same library, the same file
  add("members", "member-b", { bytes: 200, quick: q("2"), mac: "/Volumes/Old/Footage/b.mov", device: "mac_9" });
});

const folder = "/Volumes/New/Footage";
const found = [
  { path: `${folder}/a.mov`, size: 100, quick: q("1") },
  { path: `${folder}/renamed b.mov`, size: 200, quick: q("2") },
  { path: `${folder}/sub/c.mov`, size: 300, quick: q("3") },
  { path: `${folder}/kept copy.mov`, size: 400, quick: q("4") },
  { path: `${folder}/e.mov`, size: 500, quick: q("f") }, // same size, another file
];

describe("Locate", () => {
  it("lists what the Mac checks: the caller's clips on this Mac or the asked one, never another account's", async () => {
    const r = (await (await call("GET", "/api/library/lib_a/locate?device=mac_1&versionId=elsewhere")).json()) as { files: { id: string }[] };
    expect(r.files.map((f) => f.id).sort()).toEqual(["asked", "elsewhere", "gone2", "gone3", "same-size", "there"]);
    const one = (await (await call("GET", "/api/library/lib_a/locate?versionId=asked&only=1")).json()) as { files: unknown[] };
    expect(one.files).toEqual([{ id: "asked", path: "/Volumes/Old/Footage/a.mov", bytes: 100 }]);
    const theirs = (await (await call("GET", "/api/library/lib_a/locate?versionId=members&only=1")).json()) as { files: unknown[] };
    expect(theirs.files).toEqual([]);
    expect((await call("GET", "/api/library/lib_a/locate", undefined, "stranger")).status).toBe(404);
  });

  it("matches by size and quick fingerprint, and the whole folder reconnects in one go; never another account's version", async () => {
    const r = await call("POST", "/api/library/lib_a/locate", { versionId: "asked", device: "mac_1", gone: ["gone2", "gone3", "same-size", "members"], files: found });
    expect(await r.json()).toEqual({ reconnected: 3 });
    expect(versionOf("asked")).toMatchObject({ mac_path: `${folder}/a.mov`, mac_device: "mac_1" });
    expect(versionOf("gone2").mac_path).toBe(`${folder}/renamed b.mov`);
    expect(versionOf("gone3").mac_path).toBe(`${folder}/sub/c.mov`);
    // the same size is not enough
    expect(versionOf("same-size").mac_path).toBe("/Volumes/Old/Footage/e.mov");
    // a file still where the library has it is not moved to a copy
    expect(versionOf("there").mac_path).toBe("/Users/a/kept.mov");
    // the member's version of the very same file stays as it was, even named as gone
    expect(versionOf("members")).toMatchObject({ mac_path: "/Volumes/Old/Footage/b.mov", mac_device: "mac_9" });
  });

  it("refuses a body that is not files with full paths and fingerprints", async () => {
    expect((await call("POST", "/api/library/lib_a/locate", { versionId: "asked", files: [{ path: "rel/a.mov", size: 1, quick: q("1") }] })).status).toBe(400);
    expect((await call("POST", "/api/library/lib_a/locate", { versionId: "asked", files: [{ path: "/a/../b.mov", size: 1, quick: q("1") }] })).status).toBe(400);
    expect((await call("POST", "/api/library/lib_a/locate", { files: [] })).status).toBe(400);
  });

  it("a file gone from this server's disk reconnects only when the server reads the same file at the new path", async () => {
    const moved = path.join(dir, "moved");
    mkdirSync(moved, { recursive: true });
    const file = path.join(moved, "take.mov");
    writeFileSync(file, Buffer.alloc(3000, 7));
    const print = (await quickPrint(file))!;
    const d = libraryDb();
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_disk', 'lib_a', 'video', 'disk', 'owner-a', 0)").run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, state, created_by, created_at, quick)
       VALUES ('disk', 'a_disk', 1, 'libraries/lib_a/v/disk/source.mov', '/gone/take.mov', 3000, 'x', 'missing', 'owner-a', 0, ?)`,
    ).run(print);
    // the Mac's word alone is not enough for this server's own disk
    const lie = await call("POST", "/api/library/lib_a/locate", { versionId: "disk", gone: [], files: [{ path: "/nowhere/take.mov", size: 3000, quick: print }] });
    expect(await lie.json()).toEqual({ reconnected: 0 });
    const r = await call("POST", "/api/library/lib_a/locate", { versionId: "asked", gone: [], files: [{ path: file, size: 3000, quick: print }] });
    expect(await r.json()).toEqual({ reconnected: 1 });
    expect(versionOf("disk").source_path).toBe(file);
  });
});

describe("quick fingerprint backfill", () => {
  it("fills a stored original from its file, never a proxies-only clip from its proxy", async () => {
    const d = libraryDb();
    const src = path.join(dir, "up.mov");
    const fill = () => (writeFileSync(src, Buffer.alloc(5000, 3)), src); // put moves the file in
    const print = await quickPrint(fill());
    await blobs.put("libraries/lib_a/v/up/source.mov", src);
    await blobs.put("libraries/lib_a/v/px/proxy.mp4", fill());
    for (const [id, key] of [["up", "libraries/lib_a/v/up/source.mov"], ["px", "libraries/lib_a/v/px/proxy.mp4"]]) {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'owner-a', 0)").run(`a_${id}`, id);
      d.prepare(
        `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, ?, 5000, 'x', 'ready', 'owner-a', 0)`,
      ).run(id, `a_${id}`, key);
    }
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('px', 'proxy', 'libraries/lib_a/v/px/proxy.mp4', 5000)").run();
    while (await backfillQuick());
    expect(versionOf("up").quick).toBe(print);
    expect(versionOf("px").quick).toBeNull();
  });
});
