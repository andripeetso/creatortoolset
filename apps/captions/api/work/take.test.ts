import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceJob } from "../../contracts/devices";
import { WORK_V } from "../../contracts/work";
import type { JobRow, JobTable } from "../library/jobs";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});
vi.mock("./package", () => ({
  buildPackage: async (job: JobRow) => ({
    v: 1,
    job: { id: job.id, kind: job.kind, editId: "", variant: "", actor: job.actor, workspaceId: "" },
    edit: {},
    own: [],
    rows: {},
    files: [],
    caches: {},
    ai: { editor: null, analyzer: null },
  }),
  ownFile: () => null,
}));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "work-take-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
process.env.APP_SECRET = "work-take-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { MAC_WAITS } = await import("../library/shots");
const { askVersionIn } = await import("../library/transcribe");
const { aliasDevice } = await import("../library/whereis");
const { tick: runLibraryLane } = await import("../library/worker");
const { lookHeldOn } = await import("../library/mac-look");
const { CLAIM_FRESH_MS, writeBalance } = await import("../lib/balance");
const { deviceOf, devicesSaved, listDevices, pairDevice, revokeDevice, setDeviceWork, touchDevice } = await import("../lib/devices");
const { storageFilePath } = await import("../lib/storage");
const { writeServerWork } = await import("./server-work");
const { CLAIM_POLL } = await import("./routes");
const { progress } = await import("../library/estimate");
const { appRows } = await import("../activity");
const { checkWaits, resetWaitsForTest } = await import("./waits");
const {
  asks,
  called,
  computerTakesLibrary,
  LATER_KINDS,
  libraryWaitLine,
  libraryWaits,
  polled,
  polls,
  queuedFor,
  relayBusy,
  startsForLibrary,
  takesLibrary,
  where,
} = await import("./library-package");

CLAIM_POLL.holdMs = 0;

const MAC_MACHINE = {
  os: "mac",
  cpus: 12,
  memGb: 64,
  freeGb: 48,
  load: 0.1,
  disks: [{ name: "Macintosh HD", path: "/", freeGb: 400, totalGb: 1000 }],
};
const LINUX_MACHINE = {
  os: "linux",
  cpus: 32,
  memGb: 128,
  freeGb: 96,
  load: 0.05,
  disks: [
    { name: "Root", path: "/", freeGb: 500, totalGb: 1000 },
    { name: "Share", path: "/mnt/footage", share: "nas/footage", freeGb: 2000, totalGb: 4000 },
  ],
};
const HELPER_MACHINE = {
  os: "linux",
  cpus: 16,
  memGb: 32,
  freeGb: 24,
  load: 0.1,
  disks: [{ name: "Root", path: "/", freeGb: 200, totalGb: 500 }],
};

const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const post = (token: string, url: string, body: unknown, ua = "CreatorToolset/0.17.6") =>
  app.request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": ua },
    body: JSON.stringify(body),
  });
const report = (token: string, machine: Record<string, unknown>, ua = "CreatorToolset/0.17.6") =>
  post(token, "/api/devices/relay/report", { drivers: [], homes: [], machine }, ua);
const claimWork = (token: string, body: Record<string, unknown> = {}) =>
  json<{
    pkg: { job: { id: number; kind: string } } | null;
    lib?: { job: { id: number; kind: string; claim?: string }; file?: { path?: string }; original?: { bytes: number } };
    update?: true;
    account?: string;
  }>(
    post(token, "/api/devices/relay/work/claim", {
      v: WORK_V,
      steps: [],
      library: true,
      libraryKinds: LATER_KINDS,
      ...body,
    }),
  );

async function pollWait(token: string, body: unknown, ua = "CreatorToolset/0.17.6"): Promise<{ status: number; body: any }> {
  let done = false;
  const now = Date.now();
  const p = Promise.resolve(post(token, "/api/devices/relay/wait", body, ua)).then(async (r) => {
    done = true;
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  });
  for (let i = 0; i < 50 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    if (!done && i >= 2) {
      await vi.advanceTimersByTimeAsync(25_000);
      vi.setSystemTime(now);
    }
  }
  return p;
}

function enqueue(libraryId: string, versionId: string, kind: string, actor = "tiny", table: JobTable = "jobs"): JobRow {
  const db = libraryDb();
  enqueueJob(db, libraryId, versionId, kind, actor, false, table);
  return db.prepare(`SELECT * FROM ${table} WHERE version_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).get(versionId, kind) as unknown as JobRow;
}

function writeFolders(user: string, folders: unknown[]) {
  const f = storageFilePath(dir, user);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ schemaVersion: 2, folders }));
}

let seq = 0;
function addVersion(opts: {
  id?: string;
  lib?: string;
  user?: string;
  sourceKey?: string;
  sourcePath?: string | null;
  macPath?: string | null;
  macDevice?: string | null;
  fromPath?: string | null;
  fromDevice?: string | null;
  root?: string | null;
  proxy?: boolean;
  described?: boolean;
}) {
  const id = opts.id ?? `ver_${++seq}`;
  const ast = `ast_${id}`;
  const lib = opts.lib ?? "lib_tiny";
  const user = opts.user ?? "tiny";
  const sourceKey = opts.sourceKey ?? `blobs/${id}.mp4`;
  const probe = JSON.stringify({ duration: 10, vcodec: "h264", width: 1920, height: 1080, fps: 30, rotation: 0 });
  const db = libraryDb();
  db.prepare(
    "INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, 'Tiny Acrobatics', 'local', 0)",
  ).run(lib, user);
  db.prepare(
    "INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll, trashed_at) VALUES (?, ?, 'video', ?, ?, ?, 0, 'b', NULL)",
  ).run(ast, lib, id, id, user);
  db.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, probe, state, created_by, created_at, mac_path, mac_device, from_path, from_device, root)
     VALUES (?, ?, 1, ?, ?, 1000, ?, ?, 'ready', ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ast,
    sourceKey,
    opts.sourcePath ?? null,
    sourceKey.startsWith("mac:") ? sourceKey : `sha_${id}`,
    probe,
    user,
    opts.macPath ?? null,
    opts.macDevice ?? null,
    opts.fromPath ?? null,
    opts.fromDevice ?? null,
    opts.root ?? null,
  );
  if (opts.proxy) {
    db.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 500)").run(id, `px_${id}`);
  }
  if (opts.described) {
    db.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'A clip.', 'test', 1, 'b')").run(id);
  }
  return id;
}

function resetState() {
  const db = libraryDb();
  db.exec("DELETE FROM jobs; DELETE FROM edit_jobs; DELETE FROM derivatives; DELETE FROM descriptions; DELETE FROM version_places; DELETE FROM device_alias; DELETE FROM asset_versions; DELETE FROM assets;");
  polled.clear();
  called.clear();
  askVersionIn.clear();
  writeFolders("tiny", []);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  writeServerWork({ on: false });
  setOff(createUser("tiny", "password1", { role: "user" }), []);
  libraryDb()
    .prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_tiny', 'tiny', 'Tiny Acrobatics', 'local', 0)")
    .run();
});

beforeEach(async () => {
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  writeServerWork({ on: false });
  delete process.env.CT_LOCAL;
  for (const d of listDevices(() => true)) await revokeDevice(d.id);
  resetState();
  await writeBalance("tiny", { on: true, weights: {}, libraries: {}, originals: {} });
});

afterAll(async () => {
  vi.useRealTimers();
  await devicesSaved();
  rmSync(dir, { recursive: true, force: true });
});

describe("G1 taker gap and reach (tests 1–9, 9b)", () => {
  it("1 & 2. a fresh Mac whose runner polls with work:1 is told { work: true } while takesLibrary stays false; claiming with library:true hands it the proxy", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-1");
    await report(mac.token, MAC_MACHINE);
    const v = addVersion({});
    const job = enqueue("lib_tiny", v, "proxy");

    for (let i = 0; i < 3; i++) {
      const res = await pollWait(mac.token, { blobs: true, work: 1 });
      expect(res.body).toEqual({ work: true });
      expect(takesLibrary(deviceOf(mac.device.id)!)).toBe(false);
    }

    const claimed = await claimWork(mac.token);
    expect(claimed.lib?.job).toMatchObject({ id: job.id, kind: "proxy" });
    expect(takesLibrary(deviceOf(mac.device.id)!)).toBe(true);
    expect(deviceOf(mac.device.id)?.work?.libraryAt).toBe(Date.now());
  });

  it("3. a re-paired older app (new id, no machine id) is told again", async () => {
    const first = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-3");
    await report(first.token, MAC_MACHINE);
    await claimWork(first.token);
    expect(takesLibrary(deviceOf(first.device.id)!)).toBe(true);

    // Put first Off or let its claim age out and re-pair without machineId as an older app does
    vi.advanceTimersByTime(CLAIM_FRESH_MS + 1_000);
    const repaired = pairDevice("tiny", "Mac Studio", "0.17.6");
    expect(repaired.device.id).not.toBe(first.device.id);
    await report(repaired.token, MAC_MACHINE);

    const v = addVersion({});
    enqueue("lib_tiny", v, "proxy");

    const res = await pollWait(repaired.token, { blobs: true, work: 1 });
    expect(res.body).toEqual({ work: true });
    expect(takesLibrary(deviceOf(repaired.device.id)!)).toBe(false);
  });

  it("4. a row whose earlier worker claimed without library (work.at 2h old) and whose runner now polls is a starter, not a taker for server-held files; libraryOnly and This Mac never get { work: true }", async () => {
    const now = Date.now();
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-4");
    await report(mac.token, MAC_MACHINE);
    setDeviceWork(mac.device.id, { v: 1, steps: [], at: now - 2 * 3600_000 });

    const v = addVersion({});
    const job = enqueue("lib_tiny", v, "proxy");

    const res = await pollWait(mac.token, { blobs: true, work: 1 });
    expect(res.body).toEqual({ work: true });
    const d = deviceOf(mac.device.id)!;
    expect(takesLibrary(d)).toBe(false);
    expect(startsForLibrary(d)).toBe(true);
    expect(computerTakesLibrary(job)).toBe(false);

    // Starter leave decision: for a file on the Mac itself (rank 3), computerTakesLibrary leaves it to the polling starter, and libraryWaitLine counts the starter as a reader
    writeFolders("tiny", [
      {
        id: "fld_mac_4",
        name: "Shoots",
        role: "footage",
        origin: { host: mac.device.id, path: "/Users/tiny/Shoots" },
        reach: {},
      },
    ]);
    const vOnMac = addVersion({ sourceKey: "mac:on_mac_4", macPath: "/Users/tiny/Shoots/c.mov", macDevice: mac.device.id });
    const jobOnMac = enqueue("lib_tiny", vOnMac, "wave");
    expect(computerTakesLibrary(jobOnMac)).toBe(true);
    expect(libraryWaitLine(jobOnMac)).toBe("Only Mac Studio can read Shoots");
    libraryDb().prepare("DELETE FROM jobs WHERE id = ?").run(jobOnMac.id);
    writeFolders("tiny", []);

    const claimed = await claimWork(mac.token);
    expect(claimed.lib?.job.id).toBe(job.id);
    expect(takesLibrary(deviceOf(mac.device.id)!)).toBe(true);
    expect(deviceOf(mac.device.id)?.work?.libraryAt).toBe(now);

    // Queue another proxy to check libraryOnly and This Mac (CT_LOCAL=1)
    const v2 = addVersion({});
    enqueue("lib_tiny", v2, "proxy");
    await revokeDevice(mac.device.id);

    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-4");
    await report(linux.token, LINUX_MACHINE, "node");
    setDeviceWork(linux.device.id, { v: WORK_V, steps: [], libraryOnly: true });
    expect((await pollWait(linux.token, { blobs: true, work: 1 }, "node")).status).toBe(204);
    await revokeDevice(linux.device.id);

    process.env.CT_LOCAL = "1";
    const localMac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-local-4");
    await report(localMac.token, { ...MAC_MACHINE, host: hostname() });
    setDeviceWork(localMac.device.id, { v: WORK_V, steps: [] });
    expect(startsForLibrary(deviceOf(localMac.device.id)!)).toBe(false);
    expect((await pollWait(localMac.token, { blobs: true, work: 1 })).status).toBe(204);
  });

  it("5. residue: a row stored as { v: 1, library: true } with no at is not a taker, computerTakesLibrary does not leave its server-held jobs, startsForLibrary is true, and its claim makes it a taker", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-5");
    await report(mac.token, MAC_MACHINE);
    setDeviceWork(mac.device.id, { v: 1, steps: [], library: true });

    const v = addVersion({});
    const job = enqueue("lib_tiny", v, "proxy");

    const d = deviceOf(mac.device.id)!;
    expect(takesLibrary(d)).toBe(false);
    expect(startsForLibrary(d)).toBe(true);
    expect(computerTakesLibrary(job)).toBe(false);

    const res = await pollWait(mac.token, { blobs: true, work: 1 });
    expect(res.body).toEqual({ work: true });
    expect(takesLibrary(deviceOf(mac.device.id)!)).toBe(false);

    const claimed = await claimWork(mac.token);
    expect(claimed.lib?.job.id).toBe(job.id);
    expect(takesLibrary(deviceOf(mac.device.id)!)).toBe(true);
  });

  it("6. queuedFor filters out unreachable sends, non-key transcripts, unreachable proxies without originals, and proxy-less wave/sprite/fingerprint while keeping folder-translated, Windows-folder, thumb, and share rows under LIMIT 100", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-6");
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-6");
    await report(mac.token, MAC_MACHINE);
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });

    // Subcase 6a: 150 queued transcripts on a computer-model route ahead of one server-held proxy -> Mac is told and handed the proxy
    for (let i = 0; i < 150; i++) {
      const vt = addVersion({});
      enqueue("lib_tiny", vt, "transcribe");
    }
    const vProxy = addVersion({});
    const proxyJob = enqueue("lib_tiny", vProxy, "proxy");

    expect((await pollWait(mac.token, { blobs: true, work: 1 })).body).toEqual({ work: true });
    expect((await claimWork(mac.token)).lib?.job.id).toBe(proxyJob.id);

    // An editor-asked version in askVersionIn stays in queuedFor even when the default route is not on a key
    const vAsked = addVersion({ proxy: true });
    const askedJob = enqueue("lib_tiny", vAsked, "transcribe");
    askVersionIn.set(vAsked, { by: "tiny" });
    expect(queuedFor(deviceOf(mac.device.id)!).some((j) => j.id === askedJob.id)).toBe(true);

    // Subcase 6b: 150 server-held proxies with no path ahead of a wave on the Linux box's share, Linux originals off -> Linux is handed the wave
    resetState();
    writeFolders("tiny", [
      {
        id: "fld_share",
        name: "Shoots",
        role: "footage",
        origin: { host: mac.device.id, path: "/Volumes/Share/Shoots" },
        mount: { share: "nas/footage", sub: "Shoots" },
        reach: { [linux.device.id]: { path: "/mnt/footage/Shoots", freeGb: 2000, totalGb: 4000 } },
      },
    ]);
    for (let i = 0; i < 150; i++) {
      const vp = addVersion({});
      enqueue("lib_tiny", vp, "proxy");
    }
    const vWaveShare = addVersion({ macPath: "/Volumes/Share/Shoots/a.mov", macDevice: mac.device.id });
    const waveJob = enqueue("lib_tiny", vWaveShare, "wave");
    // Put Mac Off so Linux takes it uncontested
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: { [linux.device.id]: false } });
    expect((await claimWork(linux.token, { libraryOnly: true })).lib?.job.id).toBe(waveJob.id);

    // Subcase 6c: 150 Mac-uploaded proxies (from_path + Mac's from_device, outside every folder Linux reaches) and 150 sends from the Mac ahead of a wave on the share
    resetState();
    writeFolders("tiny", [
      {
        id: "fld_share",
        name: "Shoots",
        role: "footage",
        origin: { host: mac.device.id, path: "/Volumes/Share/Shoots" },
        mount: { share: "nas/footage", sub: "Shoots" },
        reach: { [linux.device.id]: { path: "/mnt/footage/Shoots", freeGb: 2000, totalGb: 4000 } },
      },
    ]);
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: { [linux.device.id]: false } });
    for (let i = 0; i < 150; i++) {
      const vm = addVersion({ fromPath: `/Users/tiny/Desktop/private_${i}.mov`, fromDevice: mac.device.id });
      enqueue("lib_tiny", vm, "proxy");
    }
    for (let i = 0; i < 150; i++) {
      const vs = addVersion({ sourceKey: `mac:send_${i}`, macPath: `/Users/tiny/Desktop/send_${i}.mov`, macDevice: mac.device.id });
      enqueue("lib_tiny", vs, "send");
    }
    const vWave2 = addVersion({ macPath: "/Volumes/Share/Shoots/b.mov", macDevice: mac.device.id });
    const waveJob2 = enqueue("lib_tiny", vWave2, "wave");
    expect(queuedFor(deviceOf(mac.device.id)!).length).toBe(100);
    expect(queuedFor(deviceOf(mac.device.id)!).every((j) => j.kind === "proxy")).toBe(true);
    expect((await claimWork(linux.token, { libraryOnly: true })).lib?.job.id).toBe(waveJob2.id);

    // Subcase 6d: Mac-uploaded file (from_path inside a shared footage folder Linux reaches as /mnt/..., from_device an evicted id, root null, no place row), Linux originals off, behind 150 rows Linux cannot take
    resetState();
    writeFolders("tiny", [
      {
        id: "fld_share",
        name: "Shoots",
        role: "footage",
        origin: { host: mac.device.id, path: "/Volumes/Share/Shoots" },
        mount: { share: "nas/footage", sub: "Shoots" },
        reach: { [linux.device.id]: { path: "/mnt/footage/Shoots", freeGb: 2000, totalGb: 4000 } },
      },
    ]);
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: { [linux.device.id]: false } });
    for (let i = 0; i < 150; i++) {
      const vu = addVersion({ fromPath: `/Users/tiny/LocalOnly/clip_${i}.mov`, fromDevice: "evicted-mac-id" });
      enqueue("lib_tiny", vu, "proxy");
      enqueue("lib_tiny", vu, "wave");
    }
    const vSharedFrom = addVersion({
      fromPath: "/Volumes/Share/Shoots/cam/take1.mov",
      fromDevice: "evicted-mac-id",
      root: null,
    });
    const sharedProxy = enqueue("lib_tiny", vSharedFrom, "proxy");
    const sharedWave = enqueue("lib_tiny", vSharedFrom, "wave");
    const vSharedSend = addVersion({
      sourceKey: "mac:shared_send",
      macPath: "/Volumes/Share/Shoots/cam/send1.mov",
      macDevice: "evicted-mac-id",
    });
    const sharedSend = enqueue("lib_tiny", vSharedSend, "send");

    expect(queuedFor(deviceOf(linux.device.id)!).map((j) => j.id)).toEqual([sharedProxy.id, sharedWave.id, sharedSend.id]);
    const gotProxy = await claimWork(linux.token, { libraryOnly: true });
    expect(gotProxy.lib?.job.id).toBe(sharedProxy.id);
    expect(gotProxy.lib?.file?.path).toBe("/mnt/footage/Shoots/cam/take1.mov");
    libraryDb().prepare("UPDATE jobs SET state = 'done', held_by = NULL WHERE id = ?").run(sharedProxy.id);
    const gotWave = await claimWork(linux.token, { libraryOnly: true });
    expect(gotWave.lib?.job.id).toBe(sharedWave.id);
    expect(gotWave.lib?.file?.path).toBe("/mnt/footage/Shoots/cam/take1.mov");
    libraryDb().prepare("UPDATE jobs SET state = 'done', held_by = NULL WHERE id = ?").run(sharedWave.id);

    // Subcase 6e: a folder whose path is a Windows path -> every row with a mac_path/from_path stays in that computer's window
    resetState();
    writeFolders("tiny", [
      {
        id: "fld_win",
        name: "WinShare",
        role: "footage",
        origin: { host: linux.device.id, path: "C:\\Footage\\Shoots" },
        reach: {},
      },
    ]);
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: { [linux.device.id]: false } });
    const vWin = addVersion({ fromPath: "/anywhere/clip.mov", fromDevice: "other-id" });
    const winProxy = enqueue("lib_tiny", vWin, "proxy");
    expect(queuedFor(deviceOf(linux.device.id)!).map((j) => j.id)).toContain(winProxy.id);

    // Subcase 6f: a queued kind the filter does not name (a thumb) is never dropped
    resetState();
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: { [linux.device.id]: false } });
    const vThumb = addVersion({});
    const thumbJob = enqueue("lib_tiny", vThumb, "thumb");
    expect(queuedFor(deviceOf(linux.device.id)!).map((j) => j.id)).toEqual([thumbJob.id]);

    // Subcase 6g: a server-held proxy whose source_path is on the Linux box's share, originals off -> still in its window and handed to Linux (rank 3)
    resetState();
    writeFolders("tiny", [
      {
        id: "fld_srv",
        name: "ServerShare",
        role: "footage",
        origin: { host: mac.device.id, path: "/srv/nas/Shoots" },
        mount: { share: "nas/footage", sub: "Shoots" },
        reach: { [linux.device.id]: { path: "/mnt/footage/Shoots", freeGb: 2000, totalGb: 4000 } },
      },
    ]);
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: { [linux.device.id]: false } });
    for (let i = 0; i < 150; i++) {
      const vp = addVersion({});
      enqueue("lib_tiny", vp, "proxy");
    }
    const vSrvShare = addVersion({ sourcePath: "/srv/nas/Shoots/day1.mov" });
    const srvProxy = enqueue("lib_tiny", vSrvShare, "proxy");
    const claimedSrv = await claimWork(linux.token, { libraryOnly: true });
    expect(claimedSrv.lib?.job.id).toBe(srvProxy.id);
    expect(claimedSrv.lib?.file?.path).toBe("/mnt/footage/Shoots/day1.mov");
  });

  it("7. resolved reach: aliased from_device gives rank 3 path in where() and parks look MAC_WAITS; folder-pointed file without place row parks look for Mac; mac-look has no static editor/reach import", async () => {
    const oldMacId = "dev_old_mac_7";
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-7");
    await report(mac.token, MAC_MACHINE);
    await claimWork(mac.token);
    aliasDevice([oldMacId], mac.device.id);

    const vAliased = addVersion({
      fromPath: "/Users/tiny/Movies/aliased.mov",
      fromDevice: oldMacId,
      described: true,
    });
    const proxyJob = enqueue("lib_tiny", vAliased, "proxy");
    const got = await claimWork(mac.token);
    expect(got.lib?.job.id).toBe(proxyJob.id);
    expect(got.lib?.file?.path).toBe("/Users/tiny/Movies/aliased.mov");
    expect(got.lib?.file?.path).toBe("/Users/tiny/Movies/aliased.mov");
    expect(
      where({
        id: vAliased,
        source_key: `blobs/${vAliased}.mp4`,
        source_path: null,
        mac_path: null,
        mac_device: null,
        from_path: "/Users/tiny/Movies/aliased.mov",
        from_device: oldMacId,
        proxy: null,
        library_id: "lib_tiny",
        asset_id: `ast_${vAliased}`,
        title: vAliased,
        kind: "video",
        bytes: 1000,
        sha256: "x",
        quick: null,
        proxy_bytes: null,
      }).mac_device,
    ).toBe(mac.device.id);

    const lookJob1 = enqueue("lib_tiny", vAliased, "look");
    while (await runLibraryLane(Date.now(), ["look"]));
    expect(libraryDb().prepare("SELECT state, error FROM jobs WHERE id = ?").get(lookJob1.id)).toEqual({
      state: "needs_key",
      error: MAC_WAITS,
    });
    const claimLook1 = await json<{ job: DeviceJob | null }>(
      post(mac.token, "/api/devices/relay/editor/claim", { kinds: ["library-look"] }),
    );
    expect(claimLook1.job).toMatchObject({
      id: lookJob1.id,
      kind: "library-look",
      options: { path: "/Users/tiny/Movies/aliased.mov", version: vAliased },
    });
    expect(lookHeldOn(mac.device.id)).toBe(true);
    // Finish look1 so mac is not busy for look2
    await post(mac.token, `/api/devices/relay/job/library-look/${lookJob1.id}/fail`, { error: "done for test" });

    // Look of a file in a folder the Mac points at (no version_places row yet)
    writeFolders("tiny", [
      {
        id: "fld_mac_local",
        name: "Camera Cards",
        role: "footage",
        origin: { host: "other-host", path: "/srv/cards" },
        reach: { [mac.device.id]: { path: "/Volumes/Cards" } },
      },
    ]);
    const vFolder = addVersion({
      sourcePath: "/srv/cards/A001.mov",
      described: true,
    });
    const lookJob2 = enqueue("lib_tiny", vFolder, "look");
    while (await runLibraryLane(Date.now(), ["look"]));
    expect(libraryDb().prepare("SELECT state, error FROM jobs WHERE id = ?").get(lookJob2.id)).toEqual({
      state: "needs_key",
      error: MAC_WAITS,
    });
    const claimLook2 = await json<{ job: DeviceJob | null }>(
      post(mac.token, "/api/devices/relay/editor/claim", { kinds: ["library-look"] }),
    );
    expect(claimLook2.job).toMatchObject({
      id: lookJob2.id,
      kind: "library-look",
      options: { path: "/Volumes/Cards/A001.mov", version: vFolder },
    });

    // No static mac-look.ts -> editor/reach.ts import
    const macLookSrc = readFileSync(path.resolve(import.meta.dirname, "../library/mac-look.ts"), "utf-8");
    expect(macLookSrc).not.toMatch(/from\s+["']\.\.\/editor\/reach["']/);
  });

  it("8. asks: counts runner polls, relay job calls (relayBusy), and held library/look jobs, while ignoring /relay/report, LocationAgent /relay/index & /relay/folders, and helper.py polls without work", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-8");
    const helper = pairDevice("tiny", "Helper PC", "1", "hw-helper-8");
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-8");

    // 8a: runner polling -> asks
    await pollWait(mac.token, { blobs: true, work: 1 });
    expect(polls(deviceOf(mac.device.id)!)).toBe(true);
    expect(asks(deviceOf(mac.device.id)!)).toBe(true);

    // 8b: no /wait for 5 min, but relay job calls (/relay/<id>/text, /relay/editor/job/.../beat) keep coming -> relayBusy & asks
    vi.advanceTimersByTime(5 * 60_000);
    expect(polls(deviceOf(mac.device.id)!)).toBe(false);
    await post(mac.token, "/api/devices/relay/req-123/text", { delta: "hi" });
    expect(relayBusy(deviceOf(mac.device.id)!)).toBe(true);
    expect(asks(deviceOf(mac.device.id)!)).toBe(true);

    vi.advanceTimersByTime(50_000);
    expect(relayBusy(deviceOf(mac.device.id)!)).toBe(false);
    await post(mac.token, "/api/devices/relay/editor/job/1/beat", {});
    expect(relayBusy(deviceOf(mac.device.id)!)).toBe(true);
    expect(asks(deviceOf(mac.device.id)!)).toBe(true);

    // 8c: device that only posts /relay/report for 40 s -> not asking
    vi.advanceTimersByTime(5 * 60_000);
    await report(mac.token, MAC_MACHINE);
    expect(asks(deviceOf(mac.device.id)!)).toBe(false);

    // 8d: LocationAgent /relay/index and /relay/folders calls for 10 min with no /wait and no job call -> not asking
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(60_000);
      await app.request("/api/devices/relay/folders", { headers: { authorization: `Bearer ${mac.token}` } });
      await post(mac.token, "/api/devices/relay/index", { folder: "fld_1", files: [] });
      expect(asks(deviceOf(mac.device.id)!)).toBe(false);
    }

    // 8e: helper row polling /relay/wait without work -> not asking
    await report(helper.token, HELPER_MACHINE, "ct-helper/1");
    await pollWait(helper.token, { blobs: false, editor: ["preview"] }, "ct-helper/1");
    expect(polls(deviceOf(helper.device.id)!)).toBe(false);
    expect(asks(deviceOf(helper.device.id)!)).toBe(false);

    // 8f: Linux box 30 min into one job (beats only, no claim) -> asks
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    const v = addVersion({ sourcePath: "/mnt/footage/long.mov" });
    writeFolders("tiny", [
      {
        id: "fld_long",
        name: "Long",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage" },
        reach: {},
      },
    ]);
    const job = enqueue("lib_tiny", v, "proxy");
    const claimed = await claimWork(linux.token, { libraryOnly: true });
    expect(claimed.lib?.job.id).toBe(job.id);
    const claimId = claimed.lib!.job.claim!;

    for (let m = 0; m < 30; m++) {
      vi.advanceTimersByTime(60_000);
      const beat = await app.request(`/api/devices/relay/work/lib/${job.id}/beat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${linux.token}`,
          "content-type": "application/json",
          "x-ct-claim": claimId,
        },
        body: JSON.stringify({}),
      });
      expect(beat.status).toBe(200);
    }
    expect(asks(deviceOf(linux.device.id)!)).toBe(true);
    expect(lookHeldOn(linux.device.id)).toBe(false);
  });

  it("9. starters vs top rank: Mac at rank 1 is not told while Linux at rank 3 asks; told when Linux is Off; not told on a rank-3 tie won by Linux under load balancing", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-9");
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-9");
    await report(mac.token, MAC_MACHINE);
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    setDeviceWork(mac.device.id, { v: WORK_V, steps: [] }); // starter

    writeFolders("tiny", [
      {
        id: "fld_9",
        name: "Share9",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage/Share9" },
        reach: {},
      },
    ]);
    const v = addVersion({ sourcePath: "/mnt/footage/Share9/clip.mov" });
    enqueue("lib_tiny", v, "proxy");

    // Linux ranks 3 (share), Mac ranks 1 (download) -> Mac is not told
    expect(await libraryWaits(deviceOf(mac.device.id)!)).toBe(false);
    expect((await pollWait(mac.token, { blobs: true, work: 1 })).status).toBe(204);

    // With Linux Off -> Mac is told
    await writeBalance("tiny", { on: true, weights: { [linux.device.id]: 0 }, libraries: {}, originals: {} });
    expect(await libraryWaits(deviceOf(mac.device.id)!)).toBe(true);
    expect((await pollWait(mac.token, { blobs: true, work: 1 })).body).toEqual({ work: true });

    // Tie at rank 3 where Linux is preferred by load balancing -> Mac is not told
    writeFolders("tiny", [
      {
        id: "fld_9",
        name: "Share9",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage/Share9" },
        reach: { [mac.device.id]: { path: "/Volumes/Share9" } },
      },
    ]);
    await writeBalance("tiny", { on: true, weights: { [linux.device.id]: 2, [mac.device.id]: 1 }, libraries: {}, originals: {} });
    touchDevice(linux.device.id);
    expect(await libraryWaits(deviceOf(mac.device.id)!)).toBe(false);
    expect((await pollWait(mac.token, { blobs: true, work: 1 })).status).toBe(204);
  });

  it("9b. low-disk and update-blocked boxes never stamp at or block the Mac; a non-libraryOnly worker with v <= tooOld still gets an editor step", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-9b");
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-9b");
    await report(mac.token, MAC_MACHINE);
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    const initialAt = deviceOf(linux.device.id)!.work!.at!;
    setDeviceWork(mac.device.id, { v: WORK_V, steps: [] }); // starter

    writeFolders("tiny", [
      {
        id: "fld_9b",
        name: "Share9b",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage/Share9b" },
        reach: {},
      },
    ]);
    const v1 = addVersion({ sourcePath: "/mnt/footage/Share9b/c1.mov" });
    const job1 = enqueue("lib_tiny", v1, "proxy");

    // Linux posts lowDisk claims every 60 s -> work.at is unchanged, and after CLAIM_FRESH_MS the Mac is told and handed the job
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(60_000);
      const r = await claimWork(linux.token, { libraryOnly: true, lowDisk: true });
      expect(r.pkg).toBeNull();
      expect(deviceOf(linux.device.id)?.work?.at).toBe(initialAt);
      expect(deviceOf(linux.device.id)?.work?.lowDisk).toBe(true);
    }
    expect(Date.now() - initialAt).toBeGreaterThan(CLAIM_FRESH_MS);
    expect((await pollWait(mac.token, { blobs: true, work: 1 })).body).toEqual({ work: true });
    const got1 = await claimWork(mac.token);
    expect(got1.lib?.job.id).toBe(job1.id);

    // Finish job1 on Mac so Mac is free for the next part
    libraryDb().prepare("UPDATE jobs SET state = 'done', held_by = NULL WHERE id = ?").run(job1.id);
    setDeviceWork(mac.device.id, { v: WORK_V, steps: [] }); // starter again

    // Same with a libraryOnly box answered update every 30 s (v <= tooOld)
    const t2 = Date.now();
    setDeviceWork(linux.device.id, { v: WORK_V, steps: [], library: true, libraryOnly: true, at: t2, libraryAt: t2, tooOld: WORK_V });
    const v2 = addVersion({ sourcePath: "/mnt/footage/Share9b/c2.mov" });
    const job2 = enqueue("lib_tiny", v2, "proxy");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      const r = await claimWork(linux.token, { v: WORK_V, libraryOnly: true });
      expect(r).toEqual({ pkg: null, update: true, account: "tiny" });
      expect(deviceOf(linux.device.id)?.work?.at).toBe(t2);
    }
    expect((await pollWait(mac.token, { blobs: true, work: 1 })).body).toEqual({ work: true });
    const got2 = await claimWork(mac.token);
    expect(got2.lib?.job.id).toBe(job2.id);
    libraryDb().prepare("UPDATE jobs SET state = 'done', held_by = NULL WHERE id = ?").run(job2.id);

    // A non-libraryOnly worker with v <= tooOld is still handed an editor step, never a lib package
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tiny", password: "password1" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const v3 = addVersion({ proxy: true });
    const editId = (
      await json<{ id: string }>(
        app.request("/api/editor", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Cut", sources: [v3] }),
        }),
      )
    ).id;
    libraryDb().exec("DELETE FROM edit_jobs");
    enqueue("lib_tiny", v3, "proxy");
    const editJob = enqueue("tiny", `${editId}:v1`, "preview", "tiny", "edit_jobs");
    setDeviceWork(mac.device.id, { v: WORK_V, steps: ["preview"], library: true, at: Date.now(), libraryAt: Date.now(), tooOld: WORK_V });
    const stepClaim = await claimWork(mac.token, { v: WORK_V, steps: ["preview"], library: true });
    expect(stepClaim.lib).toBeUndefined();
    expect(stepClaim.pkg?.job).toMatchObject({ id: editJob.id, kind: "preview" });
  });
});

describe("end to end (tests 37, 38)", () => {
  const LANE = ["probe", "thumb", "proxy", "wave", "sprite", "fingerprint", "look"];
  const libPost = (token: string, id: number, claim: string, what: string, body: unknown) =>
    app.request(`/api/devices/relay/work/lib/${id}/${what}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-ct-claim": claim },
      body: JSON.stringify(body),
    });
  /** What the computer's worker sends back for each kind (work/library.ts), with small stand-in files. */
  async function finish(token: string, lib: { job: { id: number; kind: string; claim?: string } }) {
    const { id, kind, claim = "" } = lib.job;
    const files = ({ proxy: ["proxy"], wave: ["wave"], sprite: ["sprite"], thumb: ["thumb"] } as Record<string, string[]>)[kind] ?? [];
    for (const name of files) {
      const r = await app.request(`/api/devices/relay/work/lib/${id}/file?name=${name}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "x-ct-claim": claim },
        body: new Uint8Array(64).fill(7),
      });
      expect(r.status).toBe(200);
    }
    const probe = { duration: 10, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac", width: 1920, height: 1080, fps: 30, rotation: 0 };
    const extra = kind === "fingerprint" ? { fingerprint: "fp" } : kind === "probe" ? { probe } : kind === "send" ? { probe, sha256: String(id).padStart(64, "a"), quick: String(id).padStart(64, "b") } : {};
    const answer = await json(libPost(token, id, claim, "done", { outcome: { ok: true }, files, ...extra }));
    expect([answer, libraryDb().prepare("SELECT error FROM jobs WHERE id = ?").get(id)]).toEqual([{ ok: true }, { error: null }]);
  }
  /** Activity's rows of the library for tiny. */
  async function rows() {
    const p = await progress("lib_tiny", "tiny");
    return { p, rows: appRows({ libraries: [{ id: "lib_tiny", uploading: null, progress: p }], edits: [], exports: [] }) };
  }
  const states = () => libraryDb().prepare("SELECT kind, state, held_by FROM jobs ORDER BY id").all() as { kind: string; state: string; held_by: string | null }[];

  async function setup(tag: string) {
    resetWaitsForTest(Date.now() - 10 * 60_000);
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", `hw-mac-${tag}`);
    const linux = pairDevice("tiny", "Linux box", undefined, `hw-linux-${tag}`);
    await report(mac.token, MAC_MACHINE);
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    await writeBalance("tiny", { on: true, weights: { [linux.device.id]: 100 }, libraries: {}, originals: { [linux.device.id]: false } });
    return { mac, linux };
  }
  /** One round of everything that runs: the server's lane, the runner's poll, both workers' claims, the self-check. */
  async function round(mac: { token: string; device: { id: string } }, linux: { token: string }, opts: { macWorks?: boolean; looks?: boolean } = {}) {
    while (await runLibraryLane(Date.now(), LANE));
    await pollWait(mac.token, { blobs: true, editor: ["library-look"], work: 1 });
    expect((await claimWork(linux.token, { libraryOnly: true })).lib).toBeUndefined();
    checkWaits(Date.now());
    const seen = await rows();
    expect(seen.rows.filter((r) => r.state === "ready")).toEqual([]);
    if (opts.macWorks === false) return { seen, did: 0 };
    let did = 0;
    for (let got = await claimWork(mac.token); got.lib; got = await claimWork(mac.token)) {
      await finish(mac.token, got.lib);
      did++;
    }
    if (opts.looks !== false) {
      for (;;) {
        const { job } = await json<{ job: DeviceJob | null }>(post(mac.token, "/api/devices/relay/editor/claim", { kinds: ["library-look"] }));
        if (!job) break;
        expect(job.kind).toBe("library-look");
        // the look's AI half runs here from the Mac's sheets (mac-look.test.ts): done as that lane finishes it
        expect(lookHeldOn(mac.device.id)).toBe(true);
        libraryDb().prepare("UPDATE jobs SET state = 'done', held_by = ?, done_at = ? WHERE id = ?").run(mac.device.id, Date.now(), job.id);
        did++;
      }
    }
    vi.advanceTimersByTime(30_000);
    return { seen, did };
  }

  it("37. six files added from the Mac: no ready row ever, 'Preparing 6 clips' first, the Mac takes the proxies and the looks, every job ends done on the Mac", async () => {
    const { mac, linux } = await setup("37");
    const vs = Array.from({ length: 6 }, (_, i) => addVersion({ fromPath: `/Users/tiny/Movies/clip${i}.mov`, fromDevice: mac.device.id }));
    for (const v of vs) for (const k of ["proxy", "wave", "sprite", "fingerprint", "look"]) enqueue("lib_tiny", v, k);

    // before any result: the Mac polls, and everything is work left
    while (await runLibraryLane(Date.now(), LANE));
    await pollWait(mac.token, { blobs: true, editor: ["library-look"], work: 1 });
    expect((await pollWait(mac.token, { blobs: true, editor: ["library-look"], work: 1 })).body).toMatchObject({ work: true });
    const first = await rows();
    expect(first.rows.map((r) => [r.detail, r.state])).toEqual([["Preparing 6 clips · 0%", "working"]]);
    expect(first.p.waiting).toEqual([]);

    const firstClaim = await claimWork(mac.token);
    expect(firstClaim.lib?.job.kind).toBe("proxy");
    expect(firstClaim.lib?.file?.path).toBe("/Users/tiny/Movies/clip0.mov"); // rank 3: read where it is
    await finish(mac.token, firstClaim.lib!);

    for (let i = 0; i < 10 && states().some((j) => j.state !== "done"); i++) await round(mac, linux);
    expect(states().filter((j) => j.state !== "done")).toEqual([]);
    // nothing ran on the server: every job was held by the Mac
    expect(new Set(states().map((j) => j.held_by))).toEqual(new Set([mac.device.id]));
    expect(states().filter((j) => j.kind === "look")).toHaveLength(6);
  });

  it("37. variants: browser uploads go to the Mac (rank 1), their looks read one grey 'Not made on computers yet'; files sent from the Mac (mac:) go to the Mac", async () => {
    const { mac, linux } = await setup("37b");
    const b1 = addVersion({});
    const b2 = addVersion({});
    for (const v of [b1, b2]) for (const k of ["proxy", "look"]) enqueue("lib_tiny", v, k);
    const { seen } = await round(mac, linux, { macWorks: false });
    expect(seen.rows.find((r) => r.detail.includes("shot description"))).toMatchObject({ detail: "2 shot descriptions · Not made on computers yet", state: "working" });
    const got = await claimWork(mac.token);
    expect(got.lib?.job.kind).toBe("proxy");
    expect(got.lib?.file?.path).toBeUndefined(); // rank 1: the original is downloaded
    await finish(mac.token, got.lib!);

    resetState();
    const sends = Array.from({ length: 3 }, (_, i) =>
      addVersion({ sourceKey: `mac:s${i}`, macPath: `/Users/tiny/Movies/s${i}.mov`, macDevice: mac.device.id }),
    );
    for (const v of sends) enqueue("lib_tiny", v, "send");
    await round(mac, linux, { looks: false });
    expect(states().filter((j) => j.kind === "send").map((j) => [j.state, j.held_by])).toEqual(sends.map(() => ["done", mac.device.id]));
  });

  it("37. variant: mac: files before the Mac's first claim, the Mac polling: the lane leaves their waves, the Mac is told and takes them", async () => {
    const { mac, linux } = await setup("37c");
    const vs = Array.from({ length: 2 }, (_, i) =>
      addVersion({ sourceKey: `mac:w${i}`, macPath: `/Users/tiny/Movies/w${i}.mov`, macDevice: mac.device.id }),
    );
    for (const v of vs) enqueue("lib_tiny", v, "wave");
    expect((await pollWait(mac.token, { blobs: true, work: 1 })).body).toMatchObject({ work: true });
    for (let i = 0; i < 3 && states().some((j) => j.state !== "done"); i++) await round(mac, linux, { looks: false });
    expect(states().map((j) => [j.kind, j.state, j.held_by])).toEqual(vs.map(() => ["wave", "done", mac.device.id]));
  });

  it("38. a Mac holding a long job (beating, as while it waits for the Mac-wide turn): its other job stays queued, never stuck, for 40 min, and is taken when the first ends", async () => {
    const { mac, linux } = await setup("38");
    const a = addVersion({ fromPath: "/Users/tiny/Movies/a.mov", fromDevice: mac.device.id });
    const b = addVersion({ fromPath: "/Users/tiny/Movies/b.mov", fromDevice: mac.device.id });
    const ja = enqueue("lib_tiny", a, "proxy");
    const jb = enqueue("lib_tiny", b, "proxy");
    await pollWait(mac.token, { blobs: true, work: 1 });
    const held = await claimWork(mac.token);
    expect(held.lib?.job.id).toBe(ja.id);
    for (let m = 1; m <= 40; m++) {
      vi.advanceTimersByTime(60_000);
      expect(await json(libPost(mac.token, ja.id, held.lib!.job.claim!, "beat", { line: "Making the proxy" }))).toEqual({ ok: true });
      await pollWait(mac.token, { blobs: true, work: 1 });
      checkWaits(Date.now());
      const { p, rows: r } = await rows();
      expect(p.waiting).toEqual([]);
      expect(r.filter((x) => x.state === "ready")).toEqual([]);
    }
    expect((await claimWork(linux.token, { libraryOnly: true })).lib).toBeUndefined();
    await finish(mac.token, held.lib!);
    expect((await claimWork(mac.token)).lib?.job.id).toBe(jb.id);
  });
});
