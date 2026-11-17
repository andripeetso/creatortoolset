// Copies of a Media Library (copies.ts): only the owner adds them, on their own computers; only the copy's computer takes
// its jobs; a new copy writes its marker first; each clip's current version goes once, checked by its hash; an older
// version's path is reused; the server keeps a stored original until every copy has it; Stop copying lets it go.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
const { assetsCopiesLack } = await import("./copies");

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
