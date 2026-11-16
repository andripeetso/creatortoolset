import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileRow } from "./reach";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-reach-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-reach-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { pairDevice, devicesSaved, setDeviceKinds } = await import("../lib/devices");
const { registerDeviceKinds } = await import("./engine");
const { blobs } = await import("../library/db");
const { fileFor, rankOf, waitLine } = await import("./reach");

const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const post = (token: string, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = (token: string, kinds: string[]) => json<{ job: { id: number; kind: string; editId: string; footage?: unknown } | null }>(post(token, "/api/devices/relay/editor/claim", { kinds }));

const row = (r: Partial<FileRow>): FileRow => ({ id: "v", source_key: "k", source_path: null, mac_path: null, mac_device: null, proxy: null, ...r });

describe("how a computer gets at a file", () => {
  const onMac = row({ source_key: "mac:v", mac_path: "/Users/tiny/Movies/a.mp4", mac_device: "mac" });
  const nobody = () => false;
  it("on the computer it was indexed on, else not at all when the server has no copy", () => {
    expect(fileFor(onMac, "mac", [], nobody)).toEqual({ path: "/Users/tiny/Movies/a.mp4" });
    expect(fileFor(onMac, "pc", [], nobody)).toBeNull();
  });
  it("from the server's copy: the video file, or only its proxy", () => {
    expect(fileFor(row({}), "pc", [], nobody)).toEqual({ copy: "original" });
    expect(fileFor({ ...onMac, proxy: "p" }, "pc", [], nobody)).toEqual({ copy: "proxy" });
    expect(fileFor({ ...onMac, source_key: "p", proxy: "p" }, "pc", [], nobody)).toEqual({ copy: "proxy" });   // upload "proxies": the original was dropped
    expect(fileFor({ ...onMac, source_key: "p", proxy: "p" }, "mac", [], nobody)).toEqual({ path: "/Users/tiny/Movies/a.mp4" });
  });
  it("ranks a step by its worst file", () => {
    expect(rankOf([{ path: "/a" }, { copy: "original" }])).toBe(2);
    expect(rankOf([{ path: "/a" }, { copy: "proxy" }])).toBe(1);
    expect(rankOf([{ path: "/a" }, null])).toBe(0);
    expect(rankOf([{ path: "/a" }])).toBe(3);
  });
});

let strong: { device: { id: string }; token: string };
let weak: { device: { id: string }; token: string };
let editId: string;
let cookie: string;

beforeAll(async () => {
  registerDeviceKinds(["reach-render"]);
  setOff(createUser("maker", "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "maker", password: "password1" }) });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  strong = pairDevice("maker", "Big PC");
  weak = pairDevice("maker", "Laptop");
  // the file is on the laptop only, and the server has no copy (indexed where it is, never uploaded)
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_r', 'maker', 'R', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_r1', 'lib_r', 'video', 'Take 1', 'maker', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device) VALUES
      ('ver_r1', 'ast_r1', 1, 'mac:ver_r1', 1, 'x1', 'ready', 'maker', 0, '/Users/tiny/Movies/Cartwheel.mp4', '${weak.device.id}');
  `);
  editId = (await json<{ id: string }>(app.request("/api/editor", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Reach", sources: ["ver_r1"] }) }))).id;
  // both online and reporting: the PC is far roomier, so balancing by kind alone would always pick it
  await post(strong.token, "/api/devices/relay/report", { drivers: [], homes: [], machine: { os: "linux", cpus: 32, memGb: 64, freeGb: 48, load: 0.05 } });
  await post(weak.token, "/api/devices/relay/report", { drivers: [], homes: [], machine: { os: "mac", cpus: 8, memGb: 16, freeGb: 4, load: 0.3 } });
  setDeviceKinds(strong.device.id, ["reach-render"]);
});
afterAll(async () => {
  await devicesSaved();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(rootReplaced)("a heavy step goes to a computer that can read its files", () => {
  it("the only computer with the footage takes it, though a stronger one is online and free", async () => {
    enqueueJob(libraryDb(), "maker", `${editId}:v1`, "reach-render", "maker", false, "edit_jobs");
    // before: balancing picked the PC for the kind, so the laptop was told nothing waits, and the step sat queued
    expect((await claim(weak.token, ["reach-render"])).job).toMatchObject({ kind: "reach-render", editId });
  });
  it("the stronger computer is never handed a step whose files it can't get at", async () => {
    enqueueJob(libraryDb(), "maker", `${editId}:v2`, "reach-render", "maker", false, "edit_jobs");
    expect((await claim(strong.token, ["reach-render"])).job).toBeNull();
    expect(libraryDb().prepare("SELECT state FROM edit_jobs WHERE version_id = ?").get(`${editId}:v2`)).toEqual({ state: "queued" });
  });
  it("with a copy on the server: a free computer that reads it on its own disk first, else one that downloads it", async () => {
    libraryDb().exec("UPDATE asset_versions SET source_key = 'k_r1' WHERE id = 'ver_r1'");
    // the laptop is busy with v1, so the PC takes v2 from the server's copy rather than leave it waiting
    expect((await claim(strong.token, ["reach-render"])).job).toMatchObject({ kind: "reach-render", editId });
    // both free: the laptop has the file on its disk, which beats a download
    libraryDb().exec("UPDATE edit_jobs SET state = 'done', device = NULL WHERE kind = 'reach-render'");
    enqueueJob(libraryDb(), "maker", `${editId}:v3`, "reach-render", "maker", false, "edit_jobs");
    expect((await claim(strong.token, ["reach-render"])).job).toBeNull();
    expect((await claim(weak.token, ["reach-render"])).job).toMatchObject({ kind: "reach-render", editId });
  });
  it("hands the computer that takes it the paths on its own disks: a shared folder found at another path", async () => {
    // the folder was added on the laptop (a Mac) and the PC found its marker at /mnt/footage
    mkdirSync(path.join(dir, "storage"), { recursive: true });
    const folder = { id: "fold1", role: "footage", name: "Footage", origin: { host: weak.device.id, path: "/Volumes/Footage" }, make: false, createdAt: 0, reach: { [strong.device.id]: { path: "/mnt/footage", at: 1 } } };
    writeFileSync(path.join(dir, "storage", "maker.json"), JSON.stringify({ folders: [folder] }));
    libraryDb().exec(`
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_r2', 'lib_r', 'video', 'Take 2', 'maker', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device) VALUES
        ('ver_r2', 'ast_r2', 1, 'mac:ver_r2', 1, 'x2', 'ready', 'maker', 0, '/Volumes/Footage/Shoot 1/b.mp4', '${weak.device.id}');
    `);
    const other = (await json<{ id: string }>(app.request("/api/editor", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Shared", sources: ["ver_r2"] }) }))).id;
    enqueueJob(libraryDb(), "maker", `${other}:v1`, "reach-render", "maker", false, "edit_jobs");
    // the laptop is busy with v3, so the PC takes it, reading the file where it is on its own disk
    expect((await claim(strong.token, ["reach-render"])).job).toMatchObject({ editId: other, footage: [{ id: "ver_r2", path: "/mnt/footage/Shoot 1/b.mp4" }] });
  });
  it("a computer that takes a step from the server's copy downloads it, and only the one holding the step can", async () => {
    const key = "libraries/lib_r/ver_r1/source.mp4";
    const file = path.join(dir, "take1.mp4");
    writeFileSync(file, "take one");
    await blobs.put(key, file);
    libraryDb().exec(`UPDATE asset_versions SET source_key = '${key}' WHERE id = 'ver_r1'; UPDATE edit_jobs SET state = 'done', device = NULL WHERE device = '${strong.device.id}'`);
    enqueueJob(libraryDb(), "maker", `${editId}:v4`, "reach-render", "maker", false, "edit_jobs");
    const job = (await claim(strong.token, ["reach-render"])).job!;
    expect(job.footage).toEqual([{ id: "ver_r1", copy: "original" }]);
    const get = (token: string, version: string) => app.request(`/api/devices/relay/editor/job/${job.id}/footage/${version}`, { headers: { authorization: `Bearer ${token}` } });
    const got = await get(strong.token, "ver_r1");
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("take one");
    expect((await get(weak.token, "ver_r1")).status).toBe(404);
    expect((await get(strong.token, "ver_r2")).status).toBe(404);   // not this step's file
  });
  it("a step no free computer can read says why, in one line", async () => {
    // only the laptop has Take 2 (in the laptop's Footage folder); the PC never found that folder
    writeFileSync(path.join(dir, "storage", "maker.json"), JSON.stringify({ folders: [{ id: "fold1", role: "footage", name: "Footage", origin: { host: weak.device.id, path: "/Volumes/Footage" }, make: false, createdAt: 0, reach: {} }] }));
    const other = (await json<{ id: string }>(app.request("/api/editor", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Laptop only", sources: ["ver_r2"] }) }))).id;
    setDeviceKinds(weak.device.id, ["reach-render"]);
    const job = { kind: "reach-render", version_id: `${other}:v1` };
    libraryDb().exec(`UPDATE edit_jobs SET state = 'done', device = NULL WHERE device = '${weak.device.id}'`);
    expect(waitLine("maker", job)).toBeUndefined();   // the laptop is free: it is about to take it
    libraryDb().exec(`UPDATE edit_jobs SET state = 'running', device = '${weak.device.id}' WHERE version_id = '${editId}:v1'`);
    expect(waitLine("maker", job)).toBe("Only Laptop can read Footage");
    // the Mac it was indexed on is gone and no folder holds it: named by its file
    libraryDb().exec("UPDATE asset_versions SET mac_device = 'gone' WHERE id = 'ver_r2'");
    writeFileSync(path.join(dir, "storage", "maker.json"), JSON.stringify({ folders: [] }));
    expect(waitLine("maker", job)).toBe("No computer can read b.mp4 yet: connect it on one in Settings → Storage");
    expect(waitLine("maker", { kind: "cards-draw", version_id: `${other}:v1` })).toBeUndefined();   // reads no footage
  });
});
