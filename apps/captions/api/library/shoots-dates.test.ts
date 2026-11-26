import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Smart folders by shoot on a server the clips were indexed on from a Mac (shoots.ts): a clip a Mac app before 11-19
// indexed has no filming date, so the refile files it by its modified time; a newer Mac app reads the real date once
// (the report's `filmed` answer, POST /relay/filmed) and the clip moves into its shoot. A clip the person filed stays.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "shoots-dates-"));
process.env.APP_SECRET = "shoots-dates-test-secret";

const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("./db");
const { refileShoots } = await import("./organize");
const { indexOnMac } = await import("./on-mac");

createUser("tiny", "password1");
const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tiny", password: "password1" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const json = { "content-type": "application/json" };
const YEAR = new Date().getFullYear();
const COPIED = Date.UTC(YEAR, 10, 1, 12, 0); // the files' modified time: the day they were copied to the Mac
const FILMED = Date.UTC(YEAR, 10, 12, 14, 0); // 08:00 in Costa Rica

/** The clip of the file named `name` on the Mac. */
const assetOf = (name: string) =>
  libraryDb().prepare("SELECT a.id, a.library_id FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE v.mac_path LIKE ?").get(`%/${name}`) as { id: string; library_id: string };
const inFolder = (name: string) =>
  (
    libraryDb()
      .prepare("SELECT c.name FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = ? ORDER BY c.name")
      .all(assetOf(name).id) as { name: string }[]
  ).map((r) => r.name);
const folders = () => (libraryDb().prepare("SELECT name FROM collections ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("Smart folders: a date a Mac reads later", () => {
  it("files by modified time first, then moves the clip into its shoot when the real date arrives; a person's filing stays", async () => {
    const dir = path.join(process.env.DATA_DIR!, "Tiny Footage");
    mkdirSync(dir, { recursive: true });
    const r = (await (await app.request("/api/devices", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Tiny Mac", machineId: "mac-1234-abcd" }) })).json()) as {
      device: { id: string };
      token: string;
    };
    const auth = { ...json, authorization: `Bearer ${r.token}` };
    expect((await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: r.device.id, path: dir }) })).status).toBe(200);
    const { folders: listed } = (await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string }[] };
    const id = listed[0]!.id;
    const files = ["IMG_6249.MOV", "IMG_6250.MOV"].map((name, i) => ({ name, path: path.join(dir, name), bytes: 1000 + i, mtime: COPIED, quick: String(i).repeat(64) }));
    const report = async (filmed?: boolean) => {
      const res = await app.request("/api/devices/relay/report", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ reportVersion: 2, machineId: "mac-1234-abcd", drivers: [], homes: [], ...(filmed ? { filmed } : {}), folders: [{ id, state: "ok", scan: crypto.randomUUID(), complete: true, files: files.map(({ name: _, ...f }) => f) }] }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { index: { path: string }[]; filmed?: { folder: string; path: string }[] };
    };

    // indexed by a Mac app before 11-19: no filming date; the next scan keeps the files' modified time
    expect((await report()).index).toHaveLength(2);
    // filed by the old rules before this deploy (here: not at all), so nothing is in a shoot yet
    libraryDb().prepare("UPDATE libraries SET settings = json_set(settings, '$.organize', 'default')").run();
    for (const f of files) {
      const ix = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder: id, name: f.name, path: f.path, size: f.bytes, quick: f.quick, frames: [] }) });
      expect(ix.status).toBe(200);
    }
    await report();
    // the person filed one of them themselves; then the library is set to Smart folders and the deploy's refile runs
    const d = libraryDb();
    const lib = assetOf("IMG_6250.MOV").library_id;
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES ('col_picks', ?, NULL, 'My picks', 'manual', 1, 'tiny')").run(lib);
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_picks', ?, 1, 'tiny')").run(assetOf("IMG_6250.MOV").id);
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.organize', 'ai') WHERE id = ?").run(lib);
    expect(await refileShoots(d, lib)).toBe(1);
    expect(inFolder("IMG_6249.MOV")).toEqual(["1 Nov"]);

    // a Mac app that reads filming dates is asked once for each known file with none; an older one never
    expect((await report()).filmed).toBeUndefined();
    expect((await report(true)).filmed?.map((x) => path.basename(x.path)).sort()).toEqual(["IMG_6249.MOV", "IMG_6250.MOV"]);
    for (const f of files) {
      const res = await app.request("/api/devices/relay/filmed", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ folder: id, path: f.path, size: f.bytes, capturedAt: FILMED, tz: -360, location: "+09.9800-085.6500/", camera: false }),
      });
      expect(await res.json()).toEqual({ versions: 1 });
    }
    expect(inFolder("IMG_6249.MOV")).toEqual(["12 Nov · Costa Rica"]);
    expect(inFolder("IMG_6250.MOV")).toEqual(["My picks"]); // the person's filing: never moved
    expect(folders()).toEqual(["12 Nov · Costa Rica", "My picks"]); // the empty "1 Nov" the app made is gone
    expect((await report(true)).filmed).toBeUndefined(); // read once: never asked again

    // a person who takes a clip out of a shoot's folder keeps it out: no refile files it back
    const shoot = (d.prepare("SELECT id FROM collections WHERE name = '12 Nov · Costa Rica'").get() as { id: string }).id;
    const asset = assetOf("IMG_6249.MOV").id;
    const out = await app.request(`/api/library/${lib}/collections/${shoot}/items`, { method: "DELETE", headers: { ...json, cookie }, body: JSON.stringify({ assetIds: [asset] }) });
    expect(out.status).toBe(200);
    expect(inFolder("IMG_6249.MOV")).toEqual([]);
    expect(await refileShoots(d, lib)).toBe(0);
    expect(inFolder("IMG_6249.MOV")).toEqual([]);

    // a server probe kept a sent file's write time (before 11-23): the computer's read again replaces it, the file's offset stays
    const probed = () => d.prepare("SELECT v.probe FROM asset_versions v JOIN assets a ON a.current_version_id = v.id WHERE a.id = ?").get(asset) as { probe: string };
    d.prepare("UPDATE asset_versions SET probe = json_set(json_remove(probe, '$.camera'), '$.capturedAt', ?, '$.tz', -300) WHERE id = (SELECT current_version_id FROM assets WHERE id = ?)").run(FILMED + 86_400_000, asset);
    const f = files[0]!;
    const res = await app.request("/api/devices/relay/filmed", { method: "POST", headers: auth, body: JSON.stringify({ folder: id, path: f.path, size: f.bytes, capturedAt: FILMED, tz: -360, camera: false }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(probed().probe)).toMatchObject({ capturedAt: FILMED, tz: -300, camera: false });
  });

  it("keeps what a computer read of an original behind its blurred copy, and never asks for it again", async () => {
    const dir = path.join(process.env.DATA_DIR!, "Tiny Blurred");
    mkdirSync(dir, { recursive: true });
    const r = (await (await app.request("/api/devices", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Tiny Mac", machineId: "mac-1234-abcd" }) })).json()) as { device: { id: string }; token: string };
    const auth = { ...json, authorization: `Bearer ${r.token}` };
    expect((await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: r.device.id, path: dir }) })).status).toBe(200);
    const { folders: listed } = (await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string; path: string }[] };
    const id = listed.find((f) => f.path === dir)!.id;
    const f = { path: path.join(dir, "IMG_7001.MOV"), bytes: 4321, mtime: COPIED, quick: "7".repeat(64) };
    expect((await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder: id, name: "IMG_7001.MOV", path: f.path, size: f.bytes, quick: f.quick, frames: [] }) })).status).toBe(200);
    // its blurred copy becomes the clip's current version: the original stays in its folder, no longer current
    const d = libraryDb();
    const clip = assetOf("IMG_7001.MOV");
    const original = (d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ?").get(clip.id) as { v: string }).v;
    d.prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ?").run("a".repeat(64), original);
    await indexOnMac(clip.library_id, "tiny", { name: "IMG_7001 blurred.mp4", path: path.join(dir, "Blurred", "IMG_7001 blurred.mp4"), size: 999, quick: "8".repeat(64), device: r.device.id, frames: [], blurredOf: "a".repeat(64) });
    expect((d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ?").get(clip.id) as { v: string }).v).not.toBe(original);
    const report = async () =>
      (await (
        await app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, machineId: "mac-1234-abcd", drivers: [], homes: [], filmed: true, folders: [{ id, state: "ok", scan: crypto.randomUUID(), complete: true, files: [f] }] }) })
      ).json()) as { filmed?: { path: string }[] };
    expect((await report()).filmed?.map((x) => x.path)).toEqual([f.path]);
    const res = await app.request("/api/devices/relay/filmed", { method: "POST", headers: auth, body: JSON.stringify({ folder: id, path: f.path, size: f.bytes, capturedAt: FILMED, tz: -360, camera: false }) });
    expect(await res.json()).toEqual({ versions: 1 });
    expect(JSON.parse((d.prepare("SELECT probe FROM asset_versions WHERE id = ?").get(original) as { probe: string }).probe)).toMatchObject({ capturedAt: FILMED, camera: false });
    expect((await report()).filmed).toBeUndefined();
  });
});
