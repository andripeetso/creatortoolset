import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_LOOK_KIND } from "../../contracts/devices";
import { waitingLine } from "../../contracts/library";
import { WORK_V } from "../../contracts/work";
import {
  addComputer,
  fileUnchecked,
  lowDiskOn,
  noLooksOn,
  noOriginals,
  notOnComputers,
  notThisLibrary,
  offline,
  offInBalancing,
  ownerKeeps,
  updateOn,
} from "../../src/lib/wording";
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
const dir = mkdtempSync(path.join(scratch, "work-waits-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
process.env.APP_SECRET = "work-waits-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { MAC_WAITS } = await import("../library/shots");
const { tick: runLibraryLane, leftHere, leaveToComputers } = await import("../library/worker");
const { progress } = await import("../library/estimate");
const { appRows } = await import("../activity");
const { writeBalance } = await import("../lib/balance");
const { deviceOf, devicesSaved, listDevices, pairDevice, revokeDevice, setDeviceWork, touchDevice } = await import("../lib/devices");
const { storageFilePath } = await import("../lib/storage");
const { writeServerWork } = await import("./server-work");
const { CLAIM_POLL } = await import("./routes");
const {
  called,
  LATER_KINDS,
  LIBRARY_ON_COMPUTER,
  libraryWaitLine,
  notePoll,
  polled,
} = await import("./library-package");
const {
  checkWaits,
  FRESH_MS,
  isComputer,
  last,
  resetWaitsForTest,
  snapshots,
  status,
} = await import("./waits");

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
    `sha_${id}`,
    probe,
    user,
    opts.macPath ?? null,
    opts.macDevice ?? null,
    opts.fromPath ?? null,
    opts.fromDevice ?? null,
    opts.root ?? null,
  );
  if (opts.proxy) {
    db.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 500)").run(id, `proxies/${id}.mp4`);
  }
  if (opts.described !== false) {
    db.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'A clip.', 'test', 1, 'b')").run(id);
  }
  return id;
}

describe("G3 classes: waits.ts (CT-3a)", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const tiny = createUser("tiny", "password1", { role: "admin" });
    const anna = createUser("anna", "password1", { role: "admin" });
    await setOff(tiny, []);
    await setOff(anna, []);
  });

  beforeEach(async () => {
    const start = new Date("2026-11-18T12:00:00Z").getTime();
    vi.setSystemTime(start);
    // Boot was 10 min ago unless a test tests the boot grace
    resetWaitsForTest(start - 10 * 60_000);
    polled.clear();
    called.clear();
    for (const d of listDevices(() => true)) await revokeDevice(d.id);
    const db = libraryDb();
    db.exec("DELETE FROM jobs; DELETE FROM edit_jobs; DELETE FROM derivatives; DELETE FROM descriptions; DELETE FROM stretches; DELETE FROM version_places; DELETE FROM device_alias; DELETE FROM asset_versions; DELETE FROM assets;");
    writeFolders("tiny", []);
    writeFolders("anna", []);
    await writeBalance("tiny", { on: true, weights: {}, libraries: {}, originals: {} });
    await writeBalance("anna", { on: true, weights: {}, libraries: {}, originals: {} });
    writeServerWork({ on: false });
    delete process.env.CT_LOCAL;
    delete process.env.CT_MODE;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await devicesSaved();
    rmSync(dir, { recursive: true, force: true });
  });

  it("10. queued: a claiming Linux taker (file on its share), free -> classified as queued in snapshot", async () => {
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-10");
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    // Release claim so job is still queued, while Linux has fresh claim
    writeFolders("tiny", [
      {
        id: "fld_10",
        name: "Share10",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage/Share10" },
        reach: {},
      },
    ]);
    const v = addVersion({ sourcePath: "/mnt/footage/Share10/clip.mov" });
    const job = enqueue("lib_tiny", v, "proxy");

    const snap = status("lib_tiny");
    expect(snap.byJob.get(job.id)).toEqual({ wait: "queued", actor: "tiny" });
    expect(snap.queuedIds).toEqual([job.id]);
    expect(snap.waitingIds).toEqual([]);
  });

  it("13. offline: fresh-id Mac silent 3 min -> offline; LocationAgent report changes nothing; boot grace -> queued; curl-paired Linux box -> offline; carries device and devices", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-13");
    await report(mac.token, MAC_MACHINE);
    // Runner polled 3 min ago, never claimed
    notePoll(mac.device.id, Date.now() - 3 * 60_000);

    const v = addVersion({ fromPath: "/Users/tiny/clip.mov", fromDevice: mac.device.id });
    const job = enqueue("lib_tiny", v, "proxy");

    const snap1 = status("lib_tiny");
    expect(snap1.byJob.get(job.id)).toEqual({
      wait: "offline",
      reason: offline("Mac Studio"),
      device: mac.device.id,
      devices: [mac.device.id],
      actor: "tiny",
    });
    expect(offline("Mac Studio")).toBe("Mac Studio is offline");

    // LocationAgent /relay/report changes nothing (touches device online, but does not poll with work)
    await report(mac.token, MAC_MACHINE);
    resetWaitsForTest(Date.now() - 10 * 60_000);
    const snap2 = status("lib_tiny");
    expect(snap2.byJob.get(job.id)?.wait).toBe("offline");
    expect(snap2.byJob.get(job.id)?.reason).toBe("Mac Studio is offline");

    // For POLL_FRESH_MS after BOOT -> queued, no waiting row
    resetWaitsForTest(Date.now() - 30_000);
    const snapBoot = status("lib_tiny");
    expect(snapBoot.byJob.get(job.id)).toEqual({ wait: "queued", actor: "tiny" });
    expect(snapBoot.waitingIds).toEqual([]);

    // A curl-paired Linux box before its first claim (no version, no machine id, no work) -> "Linux box is offline", never addComputer
    await revokeDevice(mac.device.id);
    const curlBox = pairDevice("tiny", "Linux box", undefined, undefined);
    expect(isComputer(deviceOf(curlBox.device.id)!)).toBe(true);
    writeFolders("tiny", [
      {
        id: "fld_13",
        name: "Share13",
        role: "footage",
        origin: { host: curlBox.device.id, path: "/mnt/footage" },
        reach: {},
      },
    ]);
    const v2 = addVersion({ sourcePath: "/mnt/footage/clip2.mov" });
    const job2 = enqueue("lib_tiny", v2, "proxy");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    const snapCurl = status("lib_tiny");
    expect(snapCurl.byJob.get(job2.id)).toEqual({
      wait: "offline",
      reason: "Linux box is offline",
      device: curlBox.device.id,
      devices: [curlBox.device.id],
      actor: "tiny",
    });

    // Multiple members of L -> carries top-ranked device and all devices in L
    const mac2 = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-13b");
    await report(mac2.token, MAC_MACHINE);
    resetWaitsForTest(Date.now() - 10 * 60_000);
    const snapMulti = status("lib_tiny");
    expect(snapMulti.byJob.get(job2.id)).toEqual({
      wait: "offline",
      reason: "Linux box is offline",
      device: curlBox.device.id,
      devices: [curlBox.device.id, mac2.device.id],
      actor: "tiny",
    });
  });

  it("14. needs and set: settings-held vs non-settings held (old app, tooOld, lowDisk, noLooksOn, helper row)", async () => {
    // 1) No computer, or only the helper row (two-row case) -> "Add a computer in Settings → Computers"
    const v1 = addVersion({});
    const job1 = enqueue("lib_tiny", v1, "proxy");
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "needs",
      reason: "Add a computer in Settings → Computers",
      href: "/settings/devices",
      actor: "tiny",
    });
    expect(addComputer).toBe("Add a computer in Settings → Computers");

    // Add helper.py row: version "1", machineId, polls without work
    const helper = pairDevice("tiny", "Helper box", "1", "hw-helper-14");
    await report(helper.token, HELPER_MACHINE, "python-requests/2.31");
    await pollWait(helper.token, { blobs: false, editor: ["cutout"] }, "python-requests/2.31");
    expect(isComputer(deviceOf(helper.device.id)!)).toBe(false);
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "needs",
      reason: "Add a computer in Settings → Computers",
      href: "/settings/devices",
      actor: "tiny",
    });

    // 2) Helper row plus a worker row that is Off -> ready row "Linux box is Off in Load balancing"
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-14");
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    await writeBalance("tiny", { on: true, weights: { [linux.device.id]: 0 }, libraries: { [linux.device.id]: ["lib_tiny"] }, originals: { [linux.device.id]: true } });
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "needs",
      reason: "Linux box is Off in Load balancing",
      href: "/settings/devices",
      actor: "tiny",
    });
    expect(offInBalancing("Linux box")).toBe("Linux box is Off in Load balancing");

    // 3) The only computer Off -> ready row "Mac Studio is Off in Load balancing", href "/settings/devices"
    await revokeDevice(linux.device.id);
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-14");
    await report(mac.token, MAC_MACHINE);
    await writeBalance("tiny", { on: true, weights: { [mac.device.id]: 0 }, libraries: {}, originals: {} });
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "needs",
      reason: "Mac Studio is Off in Load balancing",
      href: "/settings/devices",
      actor: "tiny",
    });

    // 4) Every computer excluding this library -> ready row "Mac Studio doesn't take this library"
    await writeBalance("tiny", { on: true, weights: {}, libraries: { [mac.device.id]: ["other_lib"] }, originals: {} });
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "needs",
      reason: "Mac Studio doesn't take this library",
      href: "/settings/devices",
      actor: "tiny",
    });
    expect(notThisLibrary("Mac Studio")).toBe("Mac Studio doesn't take this library");

    // 5) A file whose folder no computer reads (all lifted) -> ready row with the folder line, href "/settings/folders"
    writeFolders("tiny", [
      {
        id: "fld_shoots",
        name: "Shoots",
        role: "footage",
        origin: { host: "evicted_mac", path: "/Volumes/Shoots" },
        mount: { share: "nas/shoots" },
        reach: {},
      },
    ]);
    await writeBalance("tiny", { on: true, weights: {}, libraries: {}, originals: {} });
    const vFolder = addVersion({ sourceKey: "mac:fld", macPath: "/Volumes/Shoots/clip.mov", macDevice: "evicted_mac" });
    const jobFolder = enqueue("lib_tiny", vFolder, "proxy");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(jobFolder.id)).toEqual({
      wait: "needs",
      reason: "No computer can read Shoots: connect nas/shoots on Mac Studio",
      href: "/settings/folders",
      actor: "tiny",
    });
    libraryDb().prepare("DELETE FROM jobs WHERE id = ?").run(jobFolder.id);

    // 6) Mac excludes the library (rank 3 on file) and Linux box only lacks originals (rank 1 lifted) -> "Mac Studio doesn't take this library" (needs); with one held by an old app -> set (grey)
    const linux2 = pairDevice("tiny", "Linux box", undefined, "hw-linux-14b");
    await report(linux2.token, LINUX_MACHINE, "node");
    setDeviceWork(linux2.device.id, { v: WORK_V, steps: [], library: true, libraryOnly: true, at: Date.now(), libraryAt: Date.now() });
    const vMac = addVersion({ fromPath: "/Users/tiny/local.mov", fromDevice: mac.device.id });
    const jobMac = enqueue("lib_tiny", vMac, "proxy");
    await writeBalance("tiny", {
      on: true,
      weights: {},
      libraries: { [mac.device.id]: ["other_lib"] },
      originals: { [linux2.device.id]: false },
    });
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(jobMac.id)).toEqual({
      wait: "needs",
      reason: "Mac Studio doesn't take this library",
      href: "/settings/devices",
      actor: "tiny",
    });
    expect(noOriginals("Linux box")).toBe("Linux box doesn't download originals");

    // With Linux held by tooOld (non-setting) while Mac is held by notThisLibrary -> class is "set" (grey), top-ranked is still Mac's line
    setDeviceWork(linux2.device.id, { v: WORK_V, steps: [], library: true, libraryOnly: true, at: Date.now(), libraryAt: Date.now(), tooOld: WORK_V });
    await writeBalance("tiny", {
      on: true,
      weights: {},
      libraries: { [mac.device.id]: ["other_lib"] },
      originals: { [linux2.device.id]: true },
    });
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(jobMac.id)).toEqual({
      wait: "set",
      reason: "Mac Studio doesn't take this library",
      actor: "tiny",
    });
    await revokeDevice(linux2.device.id);
    await writeBalance("tiny", { on: true, weights: {}, libraries: {}, originals: {} });

    // 7) A runner asking with work.v 0 -> "Update Creator Toolset on Mac Studio"
    setDeviceWork(mac.device.id, { v: 0, steps: [] });
    notePoll(mac.device.id, Date.now());
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "set",
      reason: "Update Creator Toolset on Mac Studio",
      actor: "tiny",
    });
    expect(updateOn("Mac Studio")).toBe("Update Creator Toolset on Mac Studio");

    // 8) A Mac app 0.15.61 (user agent) polling /relay/wait without work, no work row -> "Update Creator Toolset on Mac Studio", never offline; same with work.v left from an earlier claim -> same, never queued
    await revokeDevice(mac.device.id);
    const oldMac = pairDevice("tiny", "Mac Studio", "0.15.61", "hw-mac-old");
    await pollWait(oldMac.token, { blobs: true, editor: [] }, "CreatorToolsetMac/0.15.61");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "set",
      reason: "Update Creator Toolset on Mac Studio",
      actor: "tiny",
    });
    setDeviceWork(oldMac.device.id, { v: WORK_V, steps: [], at: Date.now() - 3600_000 });
    await pollWait(oldMac.token, { blobs: true, editor: [] }, "CreatorToolsetMac/0.15.61");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "set",
      reason: "Update Creator Toolset on Mac Studio",
      actor: "tiny",
    });
    await revokeDevice(oldMac.device.id);

    // 9) A libraryOnly worker answered update (tooOld set), then silent for 10 min -> still "Update Creator Toolset on Linux box", never offline
    const linuxOld = pairDevice("tiny", "Linux box", undefined, "hw-linux-old");
    await report(linuxOld.token, LINUX_MACHINE, "node");
    await writeBalance("tiny", { on: true, weights: {}, libraries: {}, originals: { [linuxOld.device.id]: true } });
    setDeviceWork(linuxOld.device.id, { v: WORK_V, steps: [], library: true, libraryOnly: true, at: Date.now(), libraryAt: Date.now(), tooOld: WORK_V });
    const rUpd = await claimWork(linuxOld.token, { v: WORK_V, libraryOnly: true });
    expect(rUpd.update).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "set",
      reason: "Update Creator Toolset on Linux box",
      actor: "tiny",
    });

    // 10) A worker that handed back a lib job with update: true -> updateOn; its next claim at the same v is answered update with no job failed
    setDeviceWork(linuxOld.device.id, { v: WORK_V, steps: [], library: true, libraryOnly: true, at: Date.now(), libraryAt: Date.now() });
    const claimed = await claimWork(linuxOld.token, { v: WORK_V, libraryOnly: true });
    expect(claimed.lib?.job.id).toBe(job1.id);
    await app.request(`/api/devices/relay/work/lib/${job1.id}/fail`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${linuxOld.token}`,
        "content-type": "application/json",
        "x-ct-claim": claimed.lib!.job.claim!,
      },
      body: JSON.stringify({ error: "Newer package", update: true }),
    });
    // Re-queue job1 (run_after = 0) to check status and next claim
    libraryDb().prepare("UPDATE jobs SET state = 'queued', run_after = 0 WHERE id = ?").run(job1.id);
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "set",
      reason: "Update Creator Toolset on Linux box",
      actor: "tiny",
    });
    const attemptsBefore = (libraryDb().prepare("SELECT attempts FROM jobs WHERE id = ?").get(job1.id) as { attempts: number }).attempts;
    const nextClaim = await claimWork(linuxOld.token, { v: WORK_V, libraryOnly: true });
    expect(nextClaim.update).toBe(true);
    expect(nextClaim.lib).toBeUndefined();
    const attemptsAfter = (libraryDb().prepare("SELECT attempts FROM jobs WHERE id = ?").get(job1.id) as { attempts: number }).attempts;
    expect(attemptsAfter).toBe(attemptsBefore);

    // 11) A box in its low-disk wait -> "Linux box is short of disk space"; its last lowDisk claim 4 min ago and no calls since -> "Linux box is offline"
    setDeviceWork(linuxOld.device.id, { v: WORK_V, steps: [], library: true, libraryOnly: true, at: Date.now() - 5 * 60_000, libraryAt: Date.now() - 5 * 60_000 });
    await claimWork(linuxOld.token, { v: WORK_V, libraryOnly: true, lowDisk: true });
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "set",
      reason: "Linux box is short of disk space",
      actor: "tiny",
    });
    expect(lowDiskOn("Linux box")).toBe("Linux box is short of disk space");

    vi.advanceTimersByTime(4 * 60_000);
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "offline",
      reason: "Linux box is offline",
      device: linuxOld.device.id,
      devices: [linuxOld.device.id],
      actor: "tiny",
    });
    await revokeDevice(linuxOld.device.id);

    // 12) A current app (runner work.v 1) whose runner never polled this server -> offline, never updateOn
    const curMac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-cur");
    await report(curMac.token, MAC_MACHINE);
    setDeviceWork(curMac.device.id, { v: WORK_V, steps: [] });
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(job1.id)).toEqual({
      wait: "offline",
      reason: "Mac Studio is offline",
      device: curMac.device.id,
      devices: [curMac.device.id],
      actor: "tiny",
    });

    // 13) A Mac whose kinds lack library-look, with a look -> "Mac Studio's app doesn't make shot descriptions"
    await pollWait(curMac.token, { blobs: true, editor: ["cutout"], work: 1 });
    expect(deviceOf(curMac.device.id)?.kinds).toEqual(["cutout"]);
    const vLook = addVersion({ macPath: "/Users/tiny/look.mov", macDevice: curMac.device.id });
    const jobLook = enqueue("lib_tiny", vLook, "look");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, jobLook.id);
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(jobLook.id)).toEqual({
      wait: "set",
      reason: "Mac Studio's app doesn't make shot descriptions",
      actor: "tiny",
    });
    expect(noLooksOn("Mac Studio")).toBe("Mac Studio's app doesn't make shot descriptions");
  });

  it("15. cannot: thumb (when not in LIBRARY_ON_COMPUTER vs in it), browser upload look, and evicted mac: file with identity gap log", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-15");
    await report(mac.token, MAC_MACHINE);
    await pollWait(mac.token, { blobs: true, editor: [LIBRARY_LOOK_KIND], work: 1 });

    // 1) A queued thumb: on P3 thumb is in LIBRARY_ON_COMPUTER -> with a computer reaching the file it is queued; when not in LIBRARY_ON_COMPUTER -> notOnComputers
    const vThumb = addVersion({ fromPath: "/Users/tiny/t.mov", fromDevice: mac.device.id });
    const jobThumb = enqueue("lib_tiny", vThumb, "thumb");
    if (LIBRARY_ON_COMPUTER.includes("thumb")) {
      expect(status("lib_tiny").byJob.get(jobThumb.id)).toEqual({ wait: "queued", actor: "tiny" });
      // Temporarily test without thumb in LIBRARY_ON_COMPUTER
      const idx = (LIBRARY_ON_COMPUTER as string[]).indexOf("thumb");
      (LIBRARY_ON_COMPUTER as string[]).splice(idx, 1);
      try {
        resetWaitsForTest(Date.now() - 10 * 60_000);
        expect(status("lib_tiny").byJob.get(jobThumb.id)).toEqual({
          wait: "cannot",
          reason: "Not made on computers yet",
          actor: "tiny",
        });
      } finally {
        (LIBRARY_ON_COMPUTER as string[]).splice(idx, 0, "thumb");
      }
    } else {
      expect(status("lib_tiny").byJob.get(jobThumb.id)).toEqual({
        wait: "cannot",
        reason: "Not made on computers yet",
        actor: "tiny",
      });
    }
    expect(notOnComputers).toBe("Not made on computers yet");

    // 2) A look of a browser upload with the Mac online -> grey "Not made on computers yet"
    const vBrowser = addVersion({}); // source_key not mac:, no from_device/mac_device, no place row
    const jobBrowserLook = enqueue("lib_tiny", vBrowser, "look");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(jobBrowserLook.id)).toEqual({
      wait: "cannot",
      reason: "Not made on computers yet",
      actor: "tiny",
    });

    // 3) A look or proxy of a mac: file whose device resolves to nothing and that is in no folder -> grey "Where the file is: not checked yet", and one log line naming the identity gap while the Mac is online
    const vEvicted = addVersion({ sourceKey: "mac:ev1", macPath: "/Users/tiny/Desktop/evicted.mov", macDevice: "dev_evicted_old" });
    const jobEvictedProxy = enqueue("lib_tiny", vEvicted, "proxy");
    const jobEvictedLook = enqueue("lib_tiny", vEvicted, "look");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, jobEvictedLook.id);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetWaitsForTest(Date.now() - 10 * 60_000);
      checkWaits();
      const snap = snapshots.get("lib_tiny")!;
      expect(snap.byJob.get(jobEvictedProxy.id)).toEqual({
        wait: "cannot",
        reason: "Where the file is: not checked yet",
        actor: "tiny",
      });
      expect(snap.byJob.get(jobEvictedLook.id)).toEqual({
        wait: "cannot",
        reason: "Where the file is: not checked yet",
        actor: "tiny",
      });
      expect(fileUnchecked).toBe("Where the file is: not checked yet");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toBe(
        "[library] 1 files of lib_tiny have no place while Mac Studio is online (from dev_evicted_old)",
      );
      // Calling checkWaits again does not log a duplicate line
      checkWaits(Date.now() + 60_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("16. another person's job: look whose created_by is anna and actor tiny uses anna's computers; ownerKeeps wording", async () => {
    const annaMac = pairDevice("anna", "Anna Mac", "0.17.6", "hw-anna-16");
    await report(annaMac.token, MAC_MACHINE);
    // Anna's Mac is offline (3 min old poll)
    notePoll(annaMac.device.id, Date.now() - 3 * 60_000);

    // A look whose created_by is anna and actor is tiny -> sets from anna's computers
    const v = addVersion({ user: "anna", lib: "lib_tiny", macPath: "/Users/anna/clip.mov", macDevice: annaMac.device.id });
    const job = enqueue("lib_tiny", v, "look", "tiny");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, job.id);

    const snap = status("lib_tiny");
    expect(snap.byJob.get(job.id)).toEqual({
      wait: "offline",
      reason: "Anna Mac is offline",
      device: annaMac.device.id,
      devices: [annaMac.device.id],
      actor: "anna",
    });
    expect(ownerKeeps()).toBe("Your owner keeps its files on their computers");
    expect(ownerKeeps("Anna Mac")).toBe("Your owner keeps its files on their computers · Anna Mac is offline");
  });

  it("17. MAC_WAITS looks: Mac asks -> queued (work left); Mac silent -> grey 'Mac Studio is offline'", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-17");
    await report(mac.token, MAC_MACHINE);
    await pollWait(mac.token, { blobs: true, editor: [LIBRARY_LOOK_KIND], work: 1 });

    const v = addVersion({ sourceKey: "mac:17", macPath: "/Users/tiny/c17.mov", macDevice: mac.device.id });
    const job = enqueue("lib_tiny", v, "look");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, job.id);

    const snapAsking = status("lib_tiny");
    expect(snapAsking.byJob.get(job.id)).toEqual({ wait: "queued", actor: "tiny" });
    expect(snapAsking.queuedLookIds).toEqual([job.id]);
    expect(snapAsking.queuedLookVersions).toEqual([v]);
    expect(snapAsking.waitingIds).toEqual([]);

    // Mac silent for 3 min -> offline
    vi.advanceTimersByTime(3 * 60_000);
    resetWaitsForTest(Date.now() - 20 * 60_000);
    const snapSilent = status("lib_tiny");
    expect(snapSilent.byJob.get(job.id)).toEqual({
      wait: "offline",
      reason: "Mac Studio is offline",
      device: mac.device.id,
      devices: [mac.device.id],
      actor: "tiny",
    });
    expect(snapSilent.queuedLookIds).toEqual([]);
    expect(snapSilent.waitingIds).toEqual([job.id]);
  });

  it("19. D1: status never changes execution, snapshot caching (15 s), 500 cap, and checkWaits 20-library cap", async () => {
    // 1) Same queue run with tick() and claim routes twice, once with status() & checkWaits() between every step and once without -> identical job states, error texts, attempts and claims
    async function runSimulation(withStatusChecks: boolean) {
      resetWaitsForTest(Date.now() - 10 * 60_000);
      polled.clear();
      called.clear();
      for (const d of listDevices(() => true)) await revokeDevice(d.id);
      const db = libraryDb();
      db.exec("DELETE FROM jobs; DELETE FROM derivatives; DELETE FROM descriptions; DELETE FROM asset_versions; DELETE FROM assets;");

      const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-sim");
      await report(mac.token, MAC_MACHINE);
      const v1 = addVersion({ id: "v_sim_1", fromPath: "/Users/tiny/s1.mov", fromDevice: mac.device.id });
      const v2 = addVersion({ id: "v_sim_2" });
      enqueue("lib_tiny", v1, "proxy");
      enqueue("lib_tiny", v1, "wave");
      enqueue("lib_tiny", v2, "proxy");

      if (withStatusChecks) {
        status("lib_tiny");
        checkWaits();
      }
      await runLibraryLane(Date.now());
      if (withStatusChecks) {
        status("lib_tiny");
        checkWaits();
      }
      await pollWait(mac.token, { blobs: true, work: 1 });
      if (withStatusChecks) {
        status("lib_tiny");
        checkWaits();
      }
      const c1 = await claimWork(mac.token);
      if (withStatusChecks) {
        status("lib_tiny");
        checkWaits();
      }
      const jobs = db.prepare("SELECT kind, state, attempts, error, held_by IS NOT NULL AS held FROM jobs ORDER BY id").all();
      return { jobs, claimedKind: c1.lib?.job.kind };
    }

    const withoutChecks = await runSimulation(false);
    const withChecks = await runSimulation(true);
    expect(withChecks).toEqual(withoutChecks);

    // 2) Ten reads within 15 s classify once
    resetWaitsForTest(Date.now() - 10 * 60_000);
    const s0 = status("lib_tiny");
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(1000);
      expect(status("lib_tiny")).toBe(s0);
    }
    vi.advanceTimersByTime(FRESH_MS);
    expect(status("lib_tiny")).not.toBe(s0);

    // 3) 600 waiting jobs -> at most 500 classified
    const db = libraryDb();
    db.exec("DELETE FROM jobs;");
    db.exec("BEGIN");
    for (let i = 0; i < 600; i++) {
      const vCap = addVersion({ id: `v_cap_${i}`, described: false });
      db.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, run_after) VALUES ('lib_tiny', ?, 'proxy', 'queued', 'tiny', 0)").run(vCap);
    }
    db.exec("COMMIT");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    const snap600 = status("lib_tiny");
    expect(snap600.byJob.size).toBe(500);

    // 4) checkWaits with 30 libraries refreshes 20 (stalest first)
    db.exec("DELETE FROM jobs;");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    for (let i = 1; i <= 30; i++) {
      const libId = `lib_many_${i}`;
      const vId = addVersion({ id: `v_many_${i}`, lib: libId });
      enqueue(libId, vId, "proxy");
    }
    checkWaits();
    expect(snapshots.size).toBe(20);
    vi.advanceTimersByTime(1000);
    checkWaits();
    expect(snapshots.size).toBe(30);
  });

  it("22. This Mac (serverKind local) and an own server with video work on: checkWaits gives no computer rows other than a send from an offline Mac, and never addComputer", async () => {
    // 1) Own server with video work on, no computers registered
    writeServerWork({ on: true });
    const v1 = addVersion({});
    const jProxy = enqueue("lib_tiny", v1, "proxy");
    const jWave = enqueue("lib_tiny", v1, "wave");
    expect(leftHere(jProxy)).toBe(false);
    expect(leftHere(jWave)).toBe(false);

    checkWaits();
    const snap1 = status("lib_tiny");
    expect(snap1.byJob.size).toBe(0);
    expect(snap1.waitingIds).toEqual([]);

    // 2) This Mac (CT_LOCAL=1), with a send from an offline Mac
    process.env.CT_LOCAL = "1";
    const remoteMac = pairDevice("tiny", "Remote Mac", "0.17.6", "hw-remote-22");
    const vSend = addVersion({ sourceKey: "mac:send22", macPath: "/Users/tiny/send.mov", macDevice: remoteMac.device.id });
    const jSend = enqueue("lib_tiny", vSend, "send");
    const jLocalWave = enqueue("lib_tiny", v1, "sprite");
    expect(leftHere(jSend)).toBe("computer");
    expect(leftHere(jLocalWave)).toBe(false);

    resetWaitsForTest(Date.now() - 10 * 60_000);
    checkWaits();
    const snap2 = status("lib_tiny");
    expect([...snap2.byJob.keys()]).toEqual([jSend.id]);
    expect(snap2.byJob.get(jSend.id)).toEqual({
      wait: "offline",
      reason: "Remote Mac is offline",
      device: remoteMac.device.id,
      devices: [remoteMac.device.id],
      actor: "tiny",
    });
    expect([...snap2.byJob.values()].some((w) => w.reason === addComputer)).toBe(false);
  });

  it("waitingLine formats reason when set and falls back to away/key otherwise", () => {
    expect(waitingLine({ step: "files", count: 6, away: true, reason: "Mac Studio is offline" })).toEqual({
      text: "6 files · Mac Studio is offline",
      href: "/settings/devices",
    });
    expect(waitingLine({ step: "look", count: 14, away: true, reason: "Add a computer in Settings → Computers", href: "/settings/devices" })).toEqual({
      text: "14 shot descriptions · Add a computer in Settings → Computers",
      href: "/settings/devices",
    });
    expect(waitingLine({ step: "files", count: 6, away: true })).toEqual({
      text: "6 files wait for one of your computers",
      href: "/settings/devices",
    });
  });
});
