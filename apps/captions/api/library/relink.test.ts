import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Relink (local first, P1): a file that moved is found again by itself, from the computer's own listings, with no
// "missing" on the way. Server side only: the computer's location agent is played by its report calls.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "relink-"));
process.env.APP_SECRET = "relink-test-secret";

const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("./db");
const { quickPrint } = await import("../work/files");

createUser("ana", "password1");
const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana", password: "password1" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const json = { "content-type": "application/json" };
const asAna = { ...json, cookie };
const pair = (await (await app.request("/api/devices", { method: "POST", headers: asAna, body: JSON.stringify({ name: "Tiny Studio Mac", machineId: "machine-relink-0001" }) })).json()) as { device: { id: string }; token: string };
const mac = pair.device.id;
const auth = { ...json, authorization: `Bearer ${pair.token}` };

const DRIVE = "/Volumes/Tiny Footage";
const quick = (n: number) => n.toString(16).padStart(64, "0");
type File = { path: string; bytes: number; mtime: number; quick?: string };
type Word = { word: string; computer?: string };

async function addFolder(p: string): Promise<string> {
  const r = await app.request("/api/devices/storage/folders", { method: "POST", headers: asAna, body: JSON.stringify({ role: "footage", host: mac, path: p }) });
  expect(r.status).toBe(200);
  const { folders } = (await r.json()) as { folders: { id: string; origin: { path: string } }[] };
  return folders.find((f) => f.origin.path === p)!.id;
}
let scans = 0;
async function list(folder: string, files: File[], state = "ok"): Promise<{ index: { path: string }[] }> {
  const r = await app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, folders: [{ id: folder, state, scan: `s${++scans}`, complete: true, files }] }) });
  return (await r.json()) as { index: { path: string }[] };
}
async function index(folder: string, f: File): Promise<{ library: string; versionId: string }> {
  const r = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder, name: path.basename(f.path), path: f.path, size: f.bytes, quick: f.quick, frames: [] }) });
  return ((await r.json()) as { versions: { library: string; versionId: string }[] }).versions[0]!;
}
async function where(library: string, version: string): Promise<{ word: Word; path?: string }> {
  const r = await app.request(`/api/library/${library}/where?versions=${version}&device=${mac}`, { headers: { cookie } });
  const v = ((await r.json()) as { versions: Record<string, { word: Word; computers: { original?: { path: string } }[] }> }).versions[version]!;
  return { word: v.word, path: v.computers.find((c) => c.original?.path)?.original?.path };
}

describe("Relink: moved files are found again by themselves", () => {
  const shoots = `${DRIVE}/Shoots`;
  const archive = `${DRIVE}/Archive`;
  let A = "";
  let B = "";
  let x: { library: string; versionId: string };

  it("(a) a file moved to another subfolder of the same pointed folder relinks on the next listing, never missing", async () => {
    A = await addFolder(shoots);
    B = await addFolder(archive);
    const file = { path: `${shoots}/2025/handstand.mp4`, bytes: 4000, mtime: 1_700_000_000_000, quick: quick(1) };
    expect((await list(A, [file])).index).toEqual([{ folder: A, path: file.path }]);
    x = await index(A, file);
    expect((await where(x.library, x.versionId)).word).toEqual({ word: "here" });
    // moved inside the folder: one whole listing with the file at its new path
    const moved = { ...file, path: `${shoots}/2026/June/handstand.mp4` };
    expect((await list(A, [moved])).index).toEqual([]);
    expect(await where(x.library, x.versionId)).toEqual({ word: { word: "here" }, path: moved.path });
  });

  it("(b) a file moved from one pointed folder to another relinks by its fingerprint", async () => {
    const there = { path: `${archive}/handstand.mp4`, bytes: 4000, mtime: 1_700_000_500_000, quick: quick(1) };
    // the old folder's listing no longer has it, the other one's does (either order)
    await list(A, []);
    expect((await list(B, [there])).index).toEqual([]);
    expect(await where(x.library, x.versionId)).toEqual({ word: { word: "here" }, path: there.path });
  });

  it("(c) a renamed pointed folder reads \"Folder not found, re-point?\"; after re-point every file relinks", async () => {
    const files = [1, 2, 3].map((n) => ({ path: `${shoots}/clip-${n}.mp4`, bytes: 5000 + n, mtime: 1_700_000_000_000 + n, quick: quick(10 + n) }));
    await list(A, files);
    const vs = await Promise.all(files.map((f) => index(A, f)));
    for (const v of vs) expect((await where(v.library, v.versionId)).word).toEqual({ word: "here" });
    // renamed on the drive: the computer finds the drive but not the folder
    await list(A, [], "not_found");
    for (const v of vs) expect((await where(v.library, v.versionId)).word).toEqual({ word: "folder_not_found" });
    const renamed = `${DRIVE}/Shoots 2026`;
    const r = await app.request(`/api/devices/storage/folders/${A}/re-point`, { method: "POST", headers: asAna, body: JSON.stringify({ path: renamed }) });
    expect(r.status).toBe(200);
    expect((await list(A, files.map((f) => ({ ...f, path: f.path.replace(shoots, renamed) })))).index).toEqual([]);
    for (const [i, v] of vs.entries()) expect(await where(v.library, v.versionId)).toEqual({ word: { word: "here" }, path: `${renamed}/clip-${i + 1}.mp4` });
  });

  it("(d) an uploaded clip relinks to its file in a pointed folder by its fingerprint", async () => {
    const body = Buffer.from("Tiny Acrobatics uploaded clip ".repeat(50));
    const file = path.join(process.env.DATA_DIR!, "upload.mp4");
    writeFileSync(file, body);
    const q = (await quickPrint(file))!;
    const { libraries } = (await (await app.request("/api/library", { headers: { cookie } })).json()) as { libraries: { id: string }[] };
    const lib = libraries[0]!.id;
    const start = await app.request(`/api/library/${lib}/uploads`, { method: "POST", headers: asAna, body: JSON.stringify({ filename: "upload.mp4", size: body.length, quick: q }) });
    expect(start.status).toBe(201);
    const { id } = (await start.json()) as { id: string };
    await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { cookie, "upload-offset": "0", "content-length": String(body.length) }, body });
    const fin = (await (await app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: { cookie } })).json()) as { versionId: string };
    expect((libraryDb().prepare("SELECT quick FROM asset_versions WHERE id = ?").get(fin.versionId) as { quick: string | null }).quick).toBe(q);
    const onMac = { path: `${archive}/upload.mp4`, bytes: body.length, mtime: 1_700_000_900_000, quick: q };
    expect((await list(B, [{ path: `${archive}/handstand.mp4`, bytes: 4000, mtime: 1_700_000_500_000, quick: quick(1) }, onMac])).index).toEqual([]);
    expect(await where(lib, fin.versionId)).toEqual({ word: { word: "here" }, path: onMac.path });
  });
});
