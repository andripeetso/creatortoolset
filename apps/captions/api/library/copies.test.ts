// Copies of a Media Library (copies.ts): only the owner adds them, on their own computers; only the copy's computer takes
// its jobs; a new copy writes its marker first; each clip's current version goes once, checked by its hash; an older
// version's path is reused; the server keeps a stored original until every copy has it; Stop copying lets it go.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DeviceJob } from "../../contracts/devices";
import type { LibraryCopy } from "../../contracts/library";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-copies-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET;

const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { blobs, libraryDb } = await import("./db");
const { dropOriginal } = await import("./worker");
const { assetsCopiesLack, copiesNotice } = await import("./copies");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mac = pairDevice("local", "Tiny's Mac");
const laptop = pairDevice("local", "Tiny's laptop");
const stranger = pairDevice("bo", "Bo's Mac");
const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_c', 'local', 'L', 'local', ?, 0)").run('{"upload":"proxies"}');
d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES ('col_i', 'lib_c', NULL, 'Interviews', 'manual', 0)").run();

const relay = (url: string, body: unknown, token = mac.token) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const claim = async (token = mac.token) => ((await (await relay("/api/devices/relay/editor/claim", { kinds: ["copy"] }, token)).json()) as { job: DeviceJob | null }).job;
const answer = (id: number, body: unknown, token = mac.token) => relay(`/api/devices/relay/job/copy/${id}`, body, token);
const copies = async () => ((await (await app.request("/api/library/lib_c/copies")).json()) as { copies: LibraryCopy[] }).copies;

/** A video uploaded from a Mac, stored here with its proxy, ready; in folder Interviews. Returns its version id and bytes. */
async function seed(asset: string, n = 1): Promise<{ v: string; body: Buffer }> {
  const v = `ver-${asset}-${n}`;
  const body = Buffer.from(`${asset} v${n} original`);
  const f = path.join(dir, v);
  writeFileSync(f, body);
  await blobs.put(`libraries/lib_c/v/${v}/source`, f);
  writeFileSync(`${f}-proxy`, "proxy");
  await blobs.put(`libraries/lib_c/v/${v}/proxy.mp4`, `${f}-proxy`);
  if (n === 1) {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_c', 'video', ?, 'local', ?)").run(asset, `Clip ${asset}`, Date.now());
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_i', ?, 0, 'local')").run(asset);
  }
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at, from_path, from_device)
     VALUES (?, ?, ?, ?, ?, ?, 'video/quicktime', 'ready', 'local', ?, ?, 'mac-elsewhere')`,
  ).run(v, asset, n, `libraries/lib_c/v/${v}/source`, body.length, createHash("sha256").update(body).digest("hex"), Date.now(), `/Users/tiny/${asset}.mov`);
  d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 5)").run(v, `libraries/lib_c/v/${v}/proxy.mp4`);
  d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(v, asset);
  return { v, body };
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("copies of a Media Library", () => {
  it("adds a copy only on the owner's own computer, at an absolute folder", async () => {
    const add = (body: unknown) => app.request("/api/library/lib_c/copies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await add({ device: stranger.device.id, path: "/Volumes/Archive" })).status).toBe(403);
    expect((await add({ device: mac.device.id, path: "Archive" })).status).toBe(400);
    expect((await add({ device: mac.device.id, path: "/Volumes/A/../B" })).status).toBe(400);
    expect((await add({ device: mac.device.id, path: "/Volumes/Archive/" })).status).toBe(200);
    expect((await add({ device: mac.device.id, path: "/Volumes/Archive" })).status).toBe(409);
    expect(await copies()).toMatchObject([{ computer: "Tiny's Mac", path: "/Volumes/Archive", state: "new", pending: 0 }]);
  });

  it("hands a new copy's first job, the marker and a check, only to its own computer", async () => {
    expect(await claim(stranger.token)).toBeNull();
    expect(await claim(laptop.token)).toBeNull();
    const job = (await claim())!;
    expect(job.options).toMatchObject({ op: "check", init: "1", root: "/Volumes/Archive", library: "lib_c" });
    expect(await claim()).toBeNull(); // one at a time
    expect((await answer(job.id, { gone: [] }, laptop.token)).status).toBe(404);
    expect((await answer(job.id, { gone: [], free: 5000 })).status).toBe(200);
    expect((await copies())[0]!.state).toBe("ok");
  });

  it("copies a stored original into its plain folder, its hash checked, and keeps the original on the server until then", async () => {
    const { v, body } = await seed("ast-a");
    // a phone's upload goes before its own work has run on any computer
    d.prepare("UPDATE asset_versions SET state = 'processing' WHERE id = ?").run(v);
    expect((await copies())[0]!.pending).toBe(1);
    expect(await dropOriginal(v)).toBe(false); // the copy lacks it
    expect(assetsCopiesLack(["ast-a"]).has("ast-a")).toBe(true);
    const job = (await claim())!;
    expect(job.options).toMatchObject({ op: "copy", key: v, n: "1", rel: "Interviews/Clip ast-a.mov", size: String(body.length), sha256: sha(body) });
    expect(job.options!.prev).toBeUndefined();
    const file = await app.request(job.options!.url!, { headers: { authorization: `Bearer ${mac.token}`, range: "bytes=4-" } });
    expect(file.status).toBe(206);
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe(body.subarray(4).toString());
    expect((await app.request(job.options!.url!, { headers: { authorization: `Bearer ${laptop.token}` } })).status).toBe(404);
    expect((await answer(job.id, { done: { rel: "../x.mov", size: body.length, sha256: sha(body) } })).status).toBe(400);
    expect((await answer(job.id, { done: { rel: "Interviews/Clip ast-a.mov", size: body.length, sha256: "0".repeat(64) } })).status).toBe(409);
    expect((await answer(job.id, { done: { rel: "Interviews/Clip ast-a.mov", size: body.length, sha256: sha(body) } })).status).toBe(200);
    expect((await copies())[0]!.pending).toBe(0);
    // the copy is the clip on that computer too
    expect(d.prepare("SELECT path FROM version_places WHERE version_id = ? AND device = ?").get(v, mac.device.id)).toEqual({ path: "/Volumes/Archive/Interviews/Clip ast-a.mov" });
    expect(assetsCopiesLack(["ast-a"]).size).toBe(0);
    await new Promise((r) => setTimeout(r, 50)); // the done's own dropOriginal
    expect(d.prepare("SELECT source_key FROM asset_versions WHERE id = ?").get(v)).toEqual({ source_key: `libraries/lib_c/v/${v}/proxy.mp4` });
    expect(await claim()).toBeNull();
  });

  it("puts a newer version at the older one's path, which moves into .versions", async () => {
    const { v } = await seed("ast-a", 2);
    const job = (await claim())!;
    expect(job.options).toMatchObject({ key: v, n: "2", rel: "Interviews/Clip ast-a.mov", prev: "Interviews/Clip ast-a.mov" });
    expect((await relay(`/api/devices/relay/job/copy/${job.id}/fail`, { error: "Could not read the file" })).status).toBe(200);
    expect(await claim()).toBeNull(); // tried again in an hour
  });

  it("copies again what a check found gone", async () => {
    d.prepare("UPDATE library_copies SET checked_at = 0").run();
    const job = (await claim())!;
    expect(job.options!.op).toBe("check");
    await answer(job.id, { gone: ["ver-ast-a-1"] });
    expect(d.prepare("SELECT 1 FROM copy_files WHERE version_id = 'ver-ast-a-1'").get()).toBeUndefined();
  });

  it("holds its jobs back after the folder was not found, and says so", async () => {
    d.prepare("DELETE FROM copy_files").run();
    const { v } = await seed("ast-b");
    const job = (await claim())!;
    expect(job.options!.key).toBeDefined();
    await answer(job.id, { state: "reconnect" });
    expect((await copies())[0]!.state).toBe("reconnect");
    expect(await claim()).toBeNull();
    expect(await dropOriginal(v)).toBe(false);
  });

  it("stops copying without touching the folder, and lets the originals it held go", async () => {
    const id = (await copies())[0]!.id;
    expect((await app.request(`/api/library/lib_c/copies/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await copies()).toEqual([]);
    expect(d.prepare("SELECT source_key FROM asset_versions WHERE id = 'ver-ast-b-1'").get()).toEqual({ source_key: "libraries/lib_c/v/ver-ast-b-1/proxy.mp4" });
  });
});

describe("copies: every version, no starving, late answers, copying between computers", () => {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_d', 'local', 'D', 'local', ?, 1)").run('{"upload":"proxies"}');
  const copiesD = async () => ((await (await app.request("/api/library/lib_d/copies")).json()) as { copies: LibraryCopy[] }).copies;
  let t = 1_000;
  /** A version in lib_d: stored here, or (`on`) only on that computer's disk as an indexed file. */
  function version(asset: string, n: number, on?: { device: string; path: string }, state = "ready") {
    const v = `vd-${asset}-${n}`;
    const body = Buffer.from(`${asset} v${n}`);
    if (n === 1) d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_d', 'video', ?, 'local', ?)").run(asset, `D ${asset}`, t++);
    const key = on ? `mac:${v}` : `libraries/lib_d/v/${v}/source`;
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at, mac_path, mac_device)
       VALUES (?, ?, ?, ?, ?, ?, 'video/quicktime', ?, 'local', ?, ?, ?)`,
    ).run(v, asset, n, key, body.length, on ? `mac:${v}` : sha(body), state, t++, on?.path ?? null, on?.device ?? null);
    d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(v, asset);
    return { v, body, key };
  }
  async function store(v: { body: Buffer; key: string }) {
    const f = path.join(dir, v.key.replace(/\//g, "_"));
    writeFileSync(f, v.body);
    await blobs.put(v.key, f);
  }
  const done = (job: DeviceJob, body: Buffer, rel = job.options!.rel, token = mac.token) => answer(job.id, { done: { rel, size: body.length, sha256: sha(body) } }, token);

  it("normalises the folder, so one folder holds one copy", async () => {
    const add = (p: string) => app.request("/api/library/lib_d/copies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: mac.device.id, path: p }) });
    expect((await add("/Volumes")).status).toBe(400);
    expect((await add("/Volumes//Tiny Copy/")).status).toBe(200);
    expect((await add("/Volumes/Tiny Copy")).status).toBe(409);
    const job = (await claim())!;
    expect(job.options).toMatchObject({ op: "check", root: "/Volumes/Tiny Copy", device: mac.device.id });
    expect(job.id).not.toBe(1); // random ids: a restart never hands an old job's id again
    await answer(job.id, { gone: [] });
  });

  it("copies a version still in work when a newer one came, older first, and holds both originals", async () => {
    const v1 = version("ast-v", 1, undefined, "processing");
    const v2 = version("ast-v", 2);
    await store(v1);
    await store(v2);
    expect(assetsCopiesLack(["ast-v"]).has("ast-v")).toBe(true);
    const first = (await claim())!;
    expect(first.options).toMatchObject({ key: v1.v, n: "1", rel: "D ast-v.mov" });
    expect((await done(first, v1.body)).status).toBe(200);
    const second = (await claim())!;
    expect(second.options).toMatchObject({ key: v2.v, n: "2", rel: "D ast-v.mov", prev: "D ast-v.mov" });
    expect((await done(second, v2.body)).status).toBe(200);
    expect(assetsCopiesLack(["ast-v"]).size).toBe(0);
  });

  it("sends an older version that comes after a newer one straight into .versions", async () => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast-w', 'lib_d', 'video', 'D ast-w', 'local', ?)").run(t++);
    const put = async (n: number) => {
      const body = Buffer.from(`ast-w v${n}`);
      const key = `libraries/lib_d/v/vd-ast-w-${n}/source`;
      d.prepare(
        `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, 'ast-w', ?, ?, ?, ?, 'video/quicktime', 'ready', 'local', ?)`,
      ).run(`vd-ast-w-${n}`, n, key, body.length, sha(body), t++);
      await store({ body, key });
      return body;
    };
    const b2 = await put(2);
    d.prepare("UPDATE assets SET current_version_id = 'vd-ast-w-2' WHERE id = 'ast-w'").run();
    const newer = (await claim())!;
    expect(newer.options).toMatchObject({ key: "vd-ast-w-2", rel: "D ast-w.mov" });
    await done(newer, b2);
    const b1 = await put(1);
    const older = (await claim())!;
    expect(older.options).toMatchObject({ key: "vd-ast-w-1", n: "1", rel: ".versions/D ast-w v1.mov" });
    expect(older.options!.prev).toBeUndefined();
    await done(older, b1);
  });

  it("takes a done that comes after the job went quiet", async () => {
    const v = version("ast-late", 1);
    await store(v);
    const job = (await claim())!;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 600_000);
    try {
      expect((await done(job, v.body)).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
    expect(d.prepare("SELECT rel_path FROM copy_files WHERE version_id = ?").get(v.v)).toEqual({ rel_path: "D ast-late.mov" });
  });

  it("never lets files no computer can reach hold back a stored upload behind them", async () => {
    d.exec("BEGIN");
    // on a disk this Mac does not have (so only the paging gets past them), indexed on a computer since removed
    for (let i = 0; i < 250; i++) version(`ast-off-${i}`, 1, { device: "dev_gone", path: `/Users/tiny/off-${i}.mov` });
    d.prepare("UPDATE asset_versions SET root = 'smb://tiny-nas/footage', root_rel = id WHERE asset_id LIKE 'ast-off-%'").run();
    d.exec("COMMIT");
    const v = version("ast-phone", 1);
    await store(v);
    const job = (await claim())!;
    expect(job.options!.key).toBe(v.v);
    await done(job, v.body);
    const row = (await copiesD())[0]!;
    expect(row.pending).toBe(250);
    expect(row.waitsFor).toBe("Removed computer");
    d.prepare("DELETE FROM asset_versions WHERE asset_id LIKE 'ast-off-%'").run();
    d.prepare("DELETE FROM assets WHERE id LIKE 'ast-off-%'").run();
  });

  it("says how many files have no original left anywhere", async () => {
    version("ast-none", 1, { device: "dev_gone", path: "/Users/tiny/none.mov" });
    d.prepare("UPDATE asset_versions SET mac_path = NULL, mac_device = NULL WHERE id = 'vd-ast-none-1'").run();
    expect((await copiesD())[0]).toMatchObject({ pending: 1, noOriginal: 1 });
    d.prepare("DELETE FROM asset_versions WHERE id = 'vd-ast-none-1'").run();
  });

  it("copies between computers: the one that holds the original sends it, the copy's computer copies it, then the server lets it go", async () => {
    const body = Buffer.from("only on the laptop");
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast-lap', 'lib_d', 'video', 'Lap', 'local', ?)").run(t++);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at, mac_path, mac_device)
       VALUES ('vd-lap', 'ast-lap', 1, 'mac:q', ?, 'mac:q', 'video/quicktime', 'ready', 'local', ?, '/Users/tiny/lap.mov', ?)`,
    ).run(body.length, t++, laptop.device.id);
    d.prepare("UPDATE assets SET current_version_id = 'vd-lap' WHERE id = 'ast-lap'").run();
    expect(await claim()).toBeNull(); // the Mac can't reach it
    // the laptop away: the copy needs it
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      expect((await copiesD())[0]!.waitsFor).toBe("Tiny's laptop");
    } finally {
      later.mockRestore();
    }
    const send = (await claim(laptop.token))!;
    expect(send.options).toMatchObject({ op: "send", key: "vd-lap", size: String(body.length), paths: JSON.stringify(["/Users/tiny/lap.mov"]) });
    expect(send.options!.url).toBe(`/api/devices/relay/job/copy/${send.id}/file`);
    const post = (b: Buffer, token = laptop.token) =>
      app.request(send.options!.url!, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: b });
    expect((await post(body, mac.token)).status).toBe(404);
    expect((await post(Buffer.from("something else"))).status).toBe(409);
    expect((await post(body)).status).toBe(200);
    expect((await copiesD())[0]!.waitsFor).toBeUndefined();
    const job = (await claim())!;
    expect(job.options).toMatchObject({ op: "copy", key: "vd-lap", sha256: sha(body) }); // the hash the laptop's file has
    const file = await app.request(job.options!.url!, { headers: { authorization: `Bearer ${mac.token}` } });
    expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);
    expect((await done(job, body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(d.prepare("SELECT 1 FROM copy_sends WHERE version_id = 'vd-lap'").get()).toBeUndefined();
    expect(await claim(laptop.token)).toBeNull();
  });

  it("names only the owner's own computers", async () => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast-bo', 'lib_d', 'video', 'Bo', 'local', ?)").run(t++);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at, mac_path, mac_device)
       VALUES ('vd-bo', 'ast-bo', 1, 'mac:b', 5, 'mac:b', 'video/quicktime', 'ready', 'bo', ?, '/Users/bo/b.mov', ?)`,
    ).run(t++, stranger.device.id);
    d.prepare("UPDATE assets SET current_version_id = 'vd-bo' WHERE id = 'ast-bo'").run();
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000); // Bo's Mac offline
    try {
      expect((await copiesD())[0]!.waitsFor).toBe("another computer");
    } finally {
      later.mockRestore();
    }
    d.prepare("DELETE FROM asset_versions WHERE id = 'vd-bo'").run();
  });

  it("tells the owner once when a copy has taken nothing for two weeks while the server keeps its files", async () => {
    const v = version("ast-held", 1);
    await store(v);
    d.prepare("UPDATE library_copies SET last_seen = 0 WHERE library_id = 'lib_d'").run();
    await copiesNotice();
    const at = (d.prepare("SELECT notice_at FROM library_copies WHERE library_id = 'lib_d'").get() as { notice_at: number | null }).notice_at;
    expect(at).toBeGreaterThan(0);
    await copiesNotice();
    expect(d.prepare("SELECT notice_at FROM library_copies WHERE library_id = 'lib_d'").get()).toEqual({ notice_at: at });
  });
});
