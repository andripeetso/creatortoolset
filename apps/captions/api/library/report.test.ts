import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "relay-report-"));
process.env.APP_SECRET = "relay-report-test-secret";

const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("./db");
const { whereIs } = await import("./whereis");
const { placeWordOf } = await import("../../contracts/places");

createUser("ana", "password1");
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

  it("keeps an old pairing's id and its places when an app from before pairs again", async () => {
    const old = await pair();
    libraryDb().prepare("INSERT INTO version_places (version_id, device, path, state, source) VALUES ('v-old', ?, '/x.mp4', 'verified', 'scan')").run(old.device.id);
    const now = await pair();
    expect(now.device.id).toBe(old.device.id);
    expect(libraryDb().prepare("SELECT device FROM version_places WHERE version_id = 'v-old'").get()).toEqual({ device: old.device.id });
  });
});
