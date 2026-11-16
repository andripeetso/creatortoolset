import { mkdtempSync, rmSync } from "node:fs";
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
const { fileFor, rankOf } = await import("./reach");

const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const post = (token: string, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = (token: string, kinds: string[]) => json<{ job: { kind: string; editId: string } | null }>(post(token, "/api/devices/relay/editor/claim", { kinds }));

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

beforeAll(async () => {
  registerDeviceKinds(["reach-render"]);
  setOff(createUser("maker", "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "maker", password: "password1" }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
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
});
