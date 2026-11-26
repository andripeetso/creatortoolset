import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "relay-report-"));
process.env.APP_SECRET = "relay-report-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("./db");
const { whereIs } = await import("./whereis");
const { placeWordOf } = await import("../../contracts/places");
const { importStudioFile } = await import("../devices-storage");
const { noteMachine } = await import("../lib/devices");

// a plug-in's default-off gates (the studio's Media tool) would turn Media off for a new account: this file's account keeps it on
setOff(createUser("ana", "password1"), []);
const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana", password: "password1" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const json = { "content-type": "application/json" };
const pair = async (machineId?: string) =>
  (await (await app.request("/api/devices", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Tiny MacBook", ...(machineId ? { machineId } : {}) }) })).json()) as { device: { id: string }; token: string };

const quick = (n: number) => n.toString(16).padStart(64, "0");
const DIR = "/Volumes/Tiny Footage/Shoots";

describe("location agents: the computers report, the server records", () => {
  it("keeps a computer's id when it pairs again with its machine id, and never takes another machine's", async () => {
    const a = await pair("machine-aaaa-1111");
    const again = await pair("machine-aaaa-1111");
    expect(again.device.id).toBe(a.device.id);
    const other = await pair("machine-bbbb-2222");
    expect(other.device.id).not.toBe(a.device.id);
    const ids = ((await (await app.request("/api/devices", { headers: { cookie } })).json()) as { id: string }[]).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([a.device.id, other.device.id]));
  });

  it("lists a folder to its computer, indexes a new file in place, and says where it is", async () => {
    const { device, token } = await pair("machine-cccc-3333");
    const auth = { ...json, authorization: `Bearer ${token}` };
    const add = await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: device.id, path: DIR }) });
    expect(add.status).toBe(200);
    const { folders } = (await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string; path: string; use: string }[] };
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ path: DIR, use: "media" });
    const folder = folders[0]!.id;
    const file = { path: `${DIR}/a.mp4`, bytes: 1000, mtime: 1_700_000_000_000, quick: quick(1) };
    const report = (body: object) => app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, ...body }) });

    // a file no version matches: the agent is told to index it
    let r = (await (await report({ folders: [{ id: folder, state: "ok", scan: "s1", complete: true, files: [file] }] })).json()) as { index: { path: string }[] };
    expect(r.index).toEqual([{ folder, path: file.path }]);
    const ix = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: "a.mp4", path: file.path, size: file.bytes, quick: file.quick, frames: [] }) });
    expect(ix.status).toBe(200);
    const versionId = ((await ix.json()) as { versions: { versionId: string }[] }).versions[0]!.versionId;
    expect(versionId).toBeTruthy();
    expect(placeWordOf(whereIs(versionId), device.id)).toEqual({ word: "here" });

    // listed again: nothing to index
    r = (await (await report({ folders: [{ id: folder, state: "ok", scan: "s2", complete: true, files: [file] }] })).json()) as { index: { path: string }[] };
    expect(r.index).toEqual([]);

    // the drive goes away: not checked, never missing
    await report({ folders: [{ id: folder, state: "disk_away", disk: "Tiny Footage" }] });
    expect(whereIs(versionId)!.computers[0]!.original!.state).toBe("unchecked");

    // back, and a whole listing without the file: gone there
    await report({ folders: [{ id: folder, state: "ok", scan: "s3", complete: true, files: [] }] });
    expect(placeWordOf(whereIs(versionId), device.id)).toEqual({ word: "missing", computer: "Tiny MacBook" });

    // renamed inside the folder (same size and time, no fingerprint yet): relinked, found
    await report({ folders: [{ id: folder, state: "ok", scan: "s4", complete: true, files: [{ ...file, path: `${DIR}/renamed.mp4`, quick: undefined }] }] });
    const on = whereIs(versionId)!.computers[0]!.original!;
    expect(on).toMatchObject({ state: "found", path: `${DIR}/renamed.mp4` });

    // a row of a library the folder doesn't fill (it left that workspace) is not looked for: never gone
    const d = libraryDb();
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_left', 'ws-left', 'Left', 'local', 0)").run();
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_left', 'lib_left', 'video', 'left', 'v_left', 'ana', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('v_left', 'a_left', 1, 'mac:v_left', 5, 'x', 'ready', 'ana', 0)").run();
    d.prepare("INSERT INTO version_places (version_id, device, folder_id, path, state, source, checked_at) VALUES ('v_left', ?, ?, ?, 'verified', 'scan', 1)").run(device.id, folder, `${DIR}/left.mp4`);
    await report({ folders: [{ id: folder, state: "ok", scan: "s5", complete: true, files: [] }] });
    expect(whereIs("v_left")!.computers[0]!.original!.state).toBe("verified");

    // a file outside the folder is never recorded
    r = (await (await report({ folders: [{ id: folder, state: "ok", files: [{ ...file, path: "/Users/someone/elsewhere.mp4" }] }] })).json()) as { index: { path: string }[] };
    expect(r.index).toEqual([]);
    expect((await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: "x.mp4", path: "/Users/someone/x.mp4", size: 5, quick: quick(9), frames: [] }) })).status).toBe(400);
  });

  it("leaves AI Editor project folders and half-written files out, and takes ones indexed before out of the library", async () => {
    const { device, token } = await pair("machine-eeee-5555");
    const auth = { ...json, authorization: `Bearer ${token}` };
    const root = "/Volumes/Tiny Footage/Edits";
    await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: device.id, path: root }) });
    const folder = ((await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string; path: string }[] }).folders.find((f) => f.path === root)!.id;
    const report = (files: object[]) =>
      app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, folders: [{ id: folder, state: "ok", scan: `s${Math.random()}`, complete: true, files }] }) });
    const f = (p: string, n: number) => ({ path: `${root}/${p}`, bytes: 100 + n, mtime: 1_700_000_000_000, quick: quick(100 + n) });
    const draft = f("Hard Edit_edit/drafts/Hard Edit_V1A_D1.camera.mp4", 1);

    // a draft indexed before the rule: it leaves the library on the next report, its file untouched
    const ix = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: "d.mp4", path: draft.path, size: draft.bytes, quick: draft.quick, frames: [] }) });
    const versionId = ((await ix.json()) as { versions: { versionId: string }[] }).versions[0]!.versionId;
    const trashed = () => (libraryDb().prepare("SELECT a.trashed_at AS t FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(versionId) as { t: number | null }).t;
    expect(trashed()).toBeNull();

    const r = (await (await report([draft, f("Hard Edit_edit/MG/flash.mov", 2), f("song.m4a.tmp.m4a", 3), f("raw/clip.mp4", 4)])).json()) as { index: { path: string }[] };
    expect(r.index).toEqual([{ folder, path: `${root}/raw/clip.mp4` }]);
    expect(trashed()).not.toBeNull();

    // the same draft, now behind a live share link: it stays in the library, and the file is still left alone
    const again = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: "e.mp4", path: `${root}/Other_edit/drafts/Other.mp4`, size: 9, quick: quick(9), frames: [] }) });
    const other = ((await again.json()) as { versions: { versionId: string }[] }).versions[0]!.versionId;
    const shared = libraryDb().prepare("SELECT a.id AS id, a.library_id AS lib FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(other) as { id: string; lib: string };
    libraryDb().prepare("INSERT INTO shares (token_hash, library_id, target_kind, target_id, scope, password_hash, created_by, expires_at, views) VALUES ('tok-held', ?, 'asset', ?, 'view', NULL, 'ana', ?, 0)").run(shared.lib, shared.id, Date.now() + 86_400_000);
    await report([f("Other_edit/drafts/Other.mp4", 9)]);
    expect(libraryDb().prepare("SELECT trashed_at AS t FROM assets WHERE id = ?").get(shared.id)).toEqual({ t: null });
  });

  it("a Final exports folder nested in a Media folder is never footage: the report leaves it out and the index route refuses it", async () => {
    const { device, token } = await pair("machine-gggg-7777");
    const auth = { ...json, authorization: `Bearer ${token}` };
    const media = "/Volumes/Tiny Footage/Nested";
    const exp = `${media}/Final exports`;
    await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: device.id, path: media }) });
    await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "library", host: device.id, path: exp }) });
    const folders = ((await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string; path: string; use: string }[] }).folders;
    const folder = folders.find((f) => f.path === media && f.use === "media")!.id;
    const file = (p: string, n: number) => ({ path: `${p}`, bytes: 200 + n, mtime: 1_700_000_000_000, quick: quick(200 + n) });
    const kept = file(`${exp}/final.mp4`, 1);
    const footage = file(`${media}/Day 1/a.mp4`, 2);
    const r = (await (await app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, folders: [{ id: folder, state: "ok", scan: `n${Math.random()}`, complete: true, files: [kept, footage] }] }) })).json()) as { index: { path: string }[] };
    expect(r.index).toEqual([{ folder, path: footage.path }]);
    const ix = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: "final.mp4", path: kept.path, size: kept.bytes, quick: kept.quick, frames: [] }) });
    expect(ix.status).toBe(400);
    expect(((await ix.json()) as { error: string }).error).toBe("Inside Source media: not imported as footage");
  });

  it("keeps an old pairing's id and its places when an app from before pairs again", async () => {
    const old = await pair();
    libraryDb().prepare("INSERT INTO version_places (version_id, device, path, state, source) VALUES ('v-old', ?, '/x.mp4', 'verified', 'scan')").run(old.device.id);
    const now = await pair();
    expect(now.device.id).toBe(old.device.id);
    expect(libraryDb().prepare("SELECT device FROM version_places WHERE version_id = 'v-old'").get()).toEqual({ device: old.device.id });
  });

  it("lists a studio's Settings → Folders row (imported from its storage.json by hostname) to that computer, once", async () => {
    const SHOOT = "/Volumes/Tiny Drive/SHOOT";
    const theirs = (p: string, workspace?: string) => ({ id: `p-${p}`, role: "footage", name: "SHOOT", origin: { host: "Tiny-Mac.local", path: p }, make: false, createdAt: 1, reach: {}, ...(workspace ? { workspace } : {}) });
    // two workspaces: a folder with no workspace must be every workspace's, not the first one's alone
    const projects = path.join(process.env.DATA_DIR!, "workshop", "projects");
    mkdirSync(projects, { recursive: true });
    for (const [id, at] of [["ws-0", 1], ["ws-1", 2]] as const) writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
    const studioFile = path.join(process.env.DATA_DIR!, "studio-storage.json");
    writeFileSync(studioFile, JSON.stringify({ schemaVersion: 3, folders: [theirs(SHOOT), theirs(DIR, "ws-1")] }));
    const { device, token } = await pair("machine-dddd-4444");
    const auth = { ...json, authorization: `Bearer ${token}` };
    const listed = async () => ((await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string; path: string; workspaces: string[] | "*" }[] }).folders;
    // not imported yet: nothing is listed
    expect(await listed()).toEqual([]);
    noteMachine(device.id, { host: "tiny-mac.local", cpus: 1, memGb: 1 });
    expect(await importStudioFile(studioFile, "ana", (x) => x)).toBe(2);
    // the one with no workspace is every workspace's
    expect((await listed()).map((f) => [f.path, f.workspaces]).sort()).toEqual([[DIR, ["ws-1"]], [SHOOT, "*"]].sort());
    // one list: a second import of the same file changes nothing (the file is renamed, so it is not read again)
    expect(await importStudioFile(studioFile, "ana", (x) => x)).toBe(0);
    expect((await listed()).filter((f) => f.path === SHOOT)).toHaveLength(1);
    // its files index in place, as the account's own folder's do
    const folder = (await listed()).find((f) => f.path === DIR)!.id;
    const ix = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: "p.mp4", path: `${DIR}/p.mp4`, size: 10, quick: quick(20), frames: [] }) });
    expect(ix.status).toBe(200);
  });

  it("writes a page of a listing as one commit, so a long page never holds the server a flush a file", async () => {
    const { device, token } = await pair("machine-eeee-5555");
    const auth = { ...json, authorization: `Bearer ${token}` };
    const dir = "/Volumes/Tiny Footage/One Commit";
    await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: device.id, path: dir }) });
    const folder = ((await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string; path: string }[] }).folders.find((f) => f.path === dir)!.id;
    const files = [1, 2, 3].map((n) => ({ path: `${dir}/${n}.mp4`, bytes: 500 + n, mtime: 1_700_000_000_000, quick: quick(900 + n) }));
    for (const f of files) await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: path.basename(f.path), path: f.path, size: f.bytes, quick: f.quick, frames: 0 }) });
    const d = libraryDb();
    const exec = d.exec.bind(d);
    const said: string[] = [];
    d.exec = (sql: string) => (said.push(sql), exec(sql));
    try {
      await app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, folders: [{ id: folder, state: "ok", scan: "one", page: 0, complete: true, files }] }) });
    } finally {
      d.exec = exec;
    }
    expect(said.filter((x) => x === "BEGIN IMMEDIATE" || x === "COMMIT")).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect(d.prepare("SELECT COUNT(*) AS n FROM version_places WHERE device = ? AND state = 'verified'").get(device.id)).toEqual({ n: 3 });
  });

  it("opens the library database so a commit never waits for the disk (one flush a row stopped the whole server)", () => {
    expect(libraryDb().prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 }); // NORMAL
  });
});
