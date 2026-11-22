import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_LOOK_KIND } from "../../contracts/devices";
import { waitingLine } from "../../contracts/library";
import { WORK_V } from "../../contracts/work";
import {
  addComputer,
  aheadOf,
  behind,
  fileUnchecked,
  keptFor,
  lowDiskOn,
  noLooksOn,
  noOriginals,
  notOnComputers,
  notStarted,
  notTaking,
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
const { currentSeq } = await import("../lib/sync");
const { foldersOf } = await import("../editor/reach");
const { readBalanceSync } = await import("../lib/balance");
const {
  called,
  decide,
  LATER_KINDS,
  LIBRARY_ON_COMPUTER,
  libraryWaitLine,
  lift,
  notePoll,
  peersOf,
  polled,
  rowOf,
} = await import("./library-package");
const { claimPictures, picturesHeldOn } = await import("./pictures");
const {
  checkWaits,
  freeSince,
  FRESH_MS,
  isComputer,
  last,
  resetWaitsForTest,
  since,
  snapshots,
  status,
  STUCK_MS,
  stuckOn,
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
  // a busy test machine needs more turns before the wait answers (50 was not always enough)
  for (let i = 0; i < 1000 && !done; i++) {
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
    expect(snap.byJob.get(job.id)).toMatchObject({ wait: "queued", actor: "tiny" });
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
    expect(snapBoot.byJob.get(job.id)).toMatchObject({ wait: "queued", actor: "tiny" });
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
      expect(status("lib_tiny").byJob.get(jobThumb.id)).toMatchObject({ wait: "queued", actor: "tiny" });
      // Temporarily test without thumb in LIBRARY_ON_COMPUTER
      const idx = (LIBRARY_ON_COMPUTER as string[]).indexOf("thumb");
      (LIBRARY_ON_COMPUTER as string[]).splice(idx, 1);
      try {
        resetWaitsForTest(Date.now() - 10 * 60_000);
        expect(status("lib_tiny").byJob.get(jobThumb.id)).toEqual({
          wait: "cannot",
          reason: "Video work is off on this server, and no computer of yours can make these",
          actor: "tiny",
        });
      } finally {
        (LIBRARY_ON_COMPUTER as string[]).splice(idx, 0, "thumb");
      }
    } else {
      expect(status("lib_tiny").byJob.get(jobThumb.id)).toEqual({
        wait: "cannot",
        reason: "Video work is off on this server, and no computer of yours can make these",
        actor: "tiny",
      });
    }
    expect(notOnComputers).toBe("Video work is off on this server, and no computer of yours can make these");

    // 2) A look of a browser upload with the Mac online -> grey "Video work is off on this server, and no computer of yours can make these"
    const vBrowser = addVersion({}); // source_key not mac:, no from_device/mac_device, no place row
    const jobBrowserLook = enqueue("lib_tiny", vBrowser, "look");
    resetWaitsForTest(Date.now() - 10 * 60_000);
    expect(status("lib_tiny").byJob.get(jobBrowserLook.id)).toEqual({
      wait: "cannot",
      reason: "Video work is off on this server, and no computer of yours can make these",
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
    expect(snapAsking.byJob.get(job.id)).toMatchObject({ wait: "queued", actor: "tiny" });
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

  it("11. busy: Linux holds a 30-min proxy (no claim in that time) -> queued, never offline; picturesHeldOn counts as busy; Mac (rank 3, free, asking) and Linux (rank 2, busy) -> pick is Mac, stuck after 10 min", async () => {
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-11");
    await report(linux.token, LINUX_MACHINE, "node");
    writeFolders("tiny", [
      {
        id: "fld_11",
        name: "Share11",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage/Share11" },
        reach: {},
      },
    ]);

    const vRunning = addVersion({ sourcePath: "/mnt/footage/Share11/r.mov" });
    const vQueued = addVersion({ sourcePath: "/mnt/footage/Share11/q.mov" });
    enqueue("lib_tiny", vRunning, "proxy");
    const jQueued = enqueue("lib_tiny", vQueued, "proxy");

    const claimed = await claimWork(linux.token, { libraryOnly: true });
    expect(claimed.lib?.job.kind).toBe("proxy");

    // 30 minutes pass with no new claim while Linux still holds the running job
    vi.advanceTimersByTime(30 * 60_000);
    const snap1 = status("lib_tiny");
    expect(snap1.byJob.get(jQueued.id)).toMatchObject({ wait: "queued", actor: "tiny" });
    expect(snap1.queuedIds).toEqual([jQueued.id]);
    expect(snap1.waitingIds).toEqual([]);

    // Release the running proxy job and verify picturesHeldOn makes the device busy
    libraryDb().prepare("UPDATE jobs SET state = 'done', held_by = NULL WHERE id = ?").run(claimed.lib!.job.id);
    libraryDb()
      .prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'thumbs/r.jpg', 100)")
      .run(vRunning);
    setDeviceWork(linux.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      libraryOnly: true,
      pictures: true,
      at: Date.now(),
      libraryAt: Date.now(),
    });
    const picPkg = await claimPictures(deviceOf(linux.device.id)!, Date.now());
    expect(picPkg).not.toBeNull();
    expect(picturesHeldOn(linux.device.id, Date.now())).toBe(true);
    expect(picturesHeldOn(linux.device.id, Date.now() + 10 * 60_000)).toBe(false);
    // Pure read did not mutate held: still true at current time
    expect(picturesHeldOn(linux.device.id, Date.now())).toBe(true);

    // While Linux holds the picture job, jQueued is in class 4 (busy -> queued), and freeSince(linux) is not set
    resetWaitsForTest(Date.now() - 20 * 60_000);
    const snapPic = status("lib_tiny");
    expect(snapPic.byJob.get(jQueued.id)).toMatchObject({ wait: "queued", actor: "tiny" });
    expect(freeSince.has(linux.device.id)).toBe(false);

    // Let picture hold expire; now test Mac (rank 3, free, asking) and Linux (rank 2, busy on another job)
    vi.advanceTimersByTime(6 * 60_000);
    expect(picturesHeldOn(linux.device.id, Date.now())).toBe(false);

    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-11");
    await report(mac.token, MAC_MACHINE);
    await pollWait(mac.token, { blobs: true, work: 1 });

    // Linux holds a running wave job (busy)
    const vLinuxHold = addVersion({ proxy: true });
    const jLinuxHold = enqueue("lib_tiny", vLinuxHold, "wave");
    libraryDb()
      .prepare("UPDATE jobs SET state = 'running', held_by = ?, started_at = ? WHERE id = ?")
      .run(linux.device.id, Date.now(), jLinuxHold.id);

    // Job whose file is on the Mac (Mac ranks 3, Linux ranks 2 via proxy)
    libraryDb().prepare("DELETE FROM jobs WHERE id = ?").run(jQueued.id);
    const vMac = addVersion({ fromPath: "/Users/tiny/mac11.mov", fromDevice: mac.device.id, proxy: true });
    const jWave = enqueue("lib_tiny", vMac, "wave");

    resetWaitsForTest(Date.now() - 20 * 60_000);
    const snapBefore = status("lib_tiny");
    expect(snapBefore.byJob.get(jWave.id)).toMatchObject({ wait: "queued", actor: "tiny" });

    // Advance 10 min with Mac polling (free, asking) and never claiming -> stuck on Mac Studio
    for (let m = 1; m <= 10; m++) {
      vi.advanceTimersByTime(60_000);
      notePoll(mac.device.id, Date.now());
    }
    const snapAfter = status("lib_tiny");
    expect(snapAfter.byJob.get(jWave.id)).toEqual({
      wait: "stuck",
      reason: notStarted("Mac Studio"),
      device: mac.device.id,
      actor: "tiny",
    });
    expect(notStarted("Mac Studio")).toBe("Mac Studio hasn't started on these");
  });

  it("12. stuck: starter & taker notStarted, warn & libraryChanged once, balance tie & decide stub, higher-ranked peer, outside window, newer-job rule, and restart BOOT floor", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-12");
    await report(mac.token, MAC_MACHINE);

    const v1 = addVersion({ fromPath: "/Users/tiny/12_1.mov", fromDevice: mac.device.id });
    const v2 = addVersion({ fromPath: "/Users/tiny/12_2.mov", fromDevice: mac.device.id });
    const v3 = addVersion({ fromPath: "/Users/tiny/12_3.mov", fromDevice: mac.device.id });
    const j1 = enqueue("lib_tiny", v1, "proxy");
    const j2 = enqueue("lib_tiny", v2, "proxy");
    const j3 = enqueue("lib_tiny", v3, "proxy");

    // 1) Mac polls, is told ({ work: true }) and never claims; checkWaits runs every 60 s -> no waiting row before 10 min
    const pollRes = await pollWait(mac.token, { blobs: true, work: 1 });
    expect(pollRes.body?.work).toBe(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let changedCalls = 0;
      const runCheck = (at: number) => {
        const before = currentSeq();
        checkWaits(at);
        if (currentSeq() > before) changedCalls++;
      };
      const t0 = Date.now();
      runCheck(t0);
      for (let m = 1; m <= 9; m++) {
        const at = t0 + m * 60_000;
        vi.setSystemTime(at);
        notePoll(mac.device.id, at);
        runCheck(at);
        const snap = status("lib_tiny", at);
        expect(snap.waitingIds).toEqual([]);
        expect(snap.queuedIds).toEqual([j1.id, j2.id, j3.id]);
        expect(stuckOn.get(mac.device.id)).toBeUndefined();
      }
      expect(warnSpy).not.toHaveBeenCalled();
      expect(changedCalls).toBe(0);

      // At 10 min, 11 min, 12 min (three checks while stuck): stuck row, console.warn once, libraryChanged once
      for (let m = 10; m <= 12; m++) {
        const at = t0 + m * 60_000;
        vi.setSystemTime(at);
        notePoll(mac.device.id, at);
        runCheck(at);
      }
      const snapStuck = status("lib_tiny", Date.now());
      for (const j of [j1, j2, j3]) {
        expect(snapStuck.byJob.get(j.id)).toEqual({
          wait: "stuck",
          reason: "Mac Studio hasn't started on these",
          device: mac.device.id,
          actor: "tiny",
        });
      }
      expect(snapStuck.waitingIds).toEqual([j1.id, j2.id, j3.id]);
      expect(stuckOn.get(mac.device.id)).toBe("Mac Studio hasn't started on these");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        `[library] stuck on Mac Studio: Mac Studio hasn't started on these (3 jobs, oldest ${j1.id})`,
      );
      expect(changedCalls).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }

    // 2) A taker (library, libraryAt, old at) that polls but whose worker does not start (no fresh claims) -> same line
    const oldAt = Date.now() - 10 * 60_000;
    setDeviceWork(mac.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      at: oldAt,
      libraryAt: oldAt,
      libraryKinds: LATER_KINDS,
    });
    notePoll(mac.device.id, Date.now());
    vi.advanceTimersByTime(FRESH_MS);
    notePoll(mac.device.id, Date.now());
    const snapTakerNoClaim = status("lib_tiny");
    expect(snapTakerNoClaim.byJob.get(j1.id)).toEqual({
      wait: "stuck",
      reason: "Mac Studio hasn't started on these",
      device: mac.device.id,
      actor: "tiny",
    });

    // 3) Mac and a free Linux box at the same rank, Linux preferred by weight -> pick is Linux; when it never takes them -> "Linux box hasn't taken these yet", never about Mac; keptFor(x) via decide stub
    libraryDb().exec("DELETE FROM jobs;");
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-12");
    await report(linux.token, LINUX_MACHINE, "node");
    await writeBalance("tiny", {
      on: true,
      weights: { [linux.device.id]: 2, [mac.device.id]: 1 },
      libraries: {},
      originals: {},
    });
    const vBoth = addVersion({ proxy: true });
    const jBoth = enqueue("lib_tiny", vBoth, "wave");

    resetWaitsForTest(Date.now() - 20 * 60_000);
    setDeviceWork(linux.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      libraryOnly: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    notePoll(mac.device.id, Date.now());
    expect(status("lib_tiny").byJob.get(jBoth.id)?.wait).toBe("queued");

    for (let m = 1; m <= 10; m++) {
      vi.advanceTimersByTime(60_000);
      await report(linux.token, LINUX_MACHINE, "node");
      await report(mac.token, MAC_MACHINE);
      setDeviceWork(linux.device.id, {
        v: WORK_V,
        steps: [],
        library: true,
        libraryOnly: true,
        at: Date.now(),
        libraryAt: Date.now(),
        libraryKinds: LATER_KINDS,
      });
      notePoll(mac.device.id, Date.now());
    }
    const snapLinuxPick = status("lib_tiny");
    expect(snapLinuxPick.byJob.get(jBoth.id)).toEqual({
      wait: "stuck",
      reason: notTaking("Linux box"),
      device: linux.device.id,
      actor: "tiny",
    });
    expect(notTaking("Linux box")).toBe("Linux box hasn't taken these yet");

    // keptFor(x) when decide answers balance for pick (tested by calling status with a decide stub)
    const snapKept = status("lib_tiny", Date.now(), () => ({ skip: "balance", by: deviceOf(mac.device.id)! }));
    expect(snapKept.byJob.get(jBoth.id)).toEqual({
      wait: "stuck",
      reason: keptFor("Mac Studio"),
      device: linux.device.id,
      actor: "tiny",
    });
    expect(keptFor("Mac Studio")).toBe("Load balancing gives these to Mac Studio");

    // Also verify decide() directly on balance and rank
    const rowBoth = rowOf(vBoth)!;
    const foldersTiny = foldersOf("tiny");
    const balTiny = readBalanceSync("tiny");
    const liftedMac = lift(deviceOf(mac.device.id)!, Date.now());
    const peersForMac = peersOf("tiny", liftedMac, Date.now());
    expect(decide(liftedMac, jBoth, rowBoth, peersForMac, foldersTiny, balTiny, Date.now())).toEqual({
      skip: "balance",
      by: expect.objectContaining({ id: linux.device.id }),
    });

    // 4) A higher-ranked peer -> "Linux box takes these before Mac Studio"
    writeFolders("tiny", [
      {
        id: "fld_12",
        name: "Share12",
        role: "footage",
        origin: { host: linux.device.id, path: "/mnt/footage/Share12" },
        reach: {},
      },
    ]);
    const vShare = addVersion({ sourcePath: "/mnt/footage/Share12/s.mov" });
    const jShare = enqueue("lib_tiny", vShare, "proxy");
    const rowShare = rowOf(vShare)!;
    expect(decide(liftedMac, jShare, rowShare, peersOf("tiny", liftedMac, Date.now()), foldersOf("tiny"), balTiny, Date.now())).toEqual({
      skip: "rank",
      by: expect.objectContaining({ id: linux.device.id }),
    });
    // When Linux is busy on a picture job, pick in freeAskingL is Mac Studio, while peersOf includes Linux -> aheadOf
    libraryDb()
      .prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'thumbs/s.jpg', 100)")
      .run(vShare);
    setDeviceWork(linux.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      libraryOnly: true,
      pictures: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    await claimPictures(deviceOf(linux.device.id)!, Date.now());
    // Seed since(jShare) 10 min ago while Mac has been free & asking for 10 min
    since.set(jShare.id, Date.now() - STUCK_MS);
    const snapAhead = status("lib_tiny", Date.now() + FRESH_MS);
    expect(snapAhead.byJob.get(jShare.id)).toEqual({
      wait: "stuck",
      reason: aheadOf("Mac Studio", "Linux box"),
      device: mac.device.id,
      actor: "tiny",
    });
    expect(aheadOf("Mac Studio", "Linux box")).toBe("Linux box takes these before Mac Studio");

    // 5) The job outside the window (100) -> "Mac Studio has other library work to do first"
    await revokeDevice(linux.device.id);
    libraryDb().exec("DELETE FROM jobs;");
    const windowJobs: JobRow[] = [];
    for (let i = 0; i < 101; i++) {
      const vW = addVersion({ id: `v_win_${i}`, fromPath: `/Users/tiny/w_${i}.mov`, fromDevice: mac.device.id, described: false });
      windowJobs.push(enqueue("lib_tiny", vW, "proxy"));
    }
    const outsideJob = windowJobs[100]!;
    since.set(outsideJob.id, Date.now() - STUCK_MS);
    freeSince.set(mac.device.id, Date.now() - STUCK_MS);
    notePoll(mac.device.id, Date.now());
    const snapBehind = status("lib_tiny", Date.now() + 2 * FRESH_MS);
    expect(snapBehind.byJob.get(outsideJob.id)).toEqual({
      wait: "stuck",
      reason: behind("Mac Studio"),
      device: mac.device.id,
      actor: "tiny",
    });
    expect(behind("Mac Studio")).toBe("Mac Studio has other library work to do first");

    // 6) A job skipped while the Mac keeps taking newer ones -> stuck after 10 min even when freeSince(Mac) < 10 min
    libraryDb().exec("DELETE FROM jobs;");
    resetWaitsForTest(Date.now() - 20 * 60_000);
    const vSkip = addVersion({ fromPath: "/Users/tiny/skip1.mov", fromDevice: mac.device.id });
    const vNewer = addVersion({ fromPath: "/Users/tiny/skip2.mov", fromDevice: mac.device.id });
    const jSkip = enqueue("lib_tiny", vSkip, "proxy");
    const jNewer = enqueue("lib_tiny", vNewer, "proxy");

    setDeviceWork(mac.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    notePoll(mac.device.id, Date.now());
    // First sight at t = 0 puts jSkip in since
    expect(status("lib_tiny").byJob.get(jSkip.id)?.wait).toBe("queued");

    // At t = 5 min, Mac is running jNewer (busy -> resets freeSince(mac))
    vi.advanceTimersByTime(5 * 60_000);
    const startedNewer = Date.now();
    libraryDb()
      .prepare("UPDATE jobs SET state = 'running', held_by = ?, started_at = ? WHERE id = ?")
      .run(mac.device.id, startedNewer, jNewer.id);
    notePoll(mac.device.id, Date.now());
    expect(status("lib_tiny").byJob.get(jSkip.id)?.wait).toBe("queued");
    expect(freeSince.has(mac.device.id)).toBe(false);

    // At t = 8 min, jNewer finishes; Mac becomes free again (freeSince = t + 8 min)
    vi.advanceTimersByTime(3 * 60_000);
    libraryDb()
      .prepare("UPDATE jobs SET state = 'done', done_at = ? WHERE id = ?")
      .run(Date.now(), jNewer.id);
    notePoll(mac.device.id, Date.now());
    setDeviceWork(mac.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    expect(status("lib_tiny").byJob.get(jSkip.id)?.wait).toBe("queued");

    // At t = 10 min (freeSince is only 2 min old, but since(jSkip) is 10 min old and jNewer > jSkip ran after since(jSkip)) -> stuck!
    vi.advanceTimersByTime(2 * 60_000);
    notePoll(mac.device.id, Date.now());
    setDeviceWork(mac.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    const snapSkipped = status("lib_tiny");
    expect(snapSkipped.byJob.get(jSkip.id)).toEqual({
      wait: "stuck",
      reason: "Mac Studio hasn't taken these yet",
      device: mac.device.id,
      actor: "tiny",
    });

    // 7) Process restart (BOOT = now, maps cleared) -> no stuck for 10 min
    resetWaitsForTest(Date.now());
    notePoll(mac.device.id, Date.now());
    expect(status("lib_tiny").byJob.get(jSkip.id)?.wait).toBe("queued");
    vi.advanceTimersByTime(9 * 60_000);
    notePoll(mac.device.id, Date.now());
    setDeviceWork(mac.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    expect(status("lib_tiny").byJob.get(jSkip.id)?.wait).toBe("queued");
    vi.advanceTimersByTime(60_000);
    notePoll(mac.device.id, Date.now());
    setDeviceWork(mac.device.id, {
      v: WORK_V,
      steps: [],
      library: true,
      at: Date.now(),
      libraryAt: Date.now(),
      libraryKinds: LATER_KINDS,
    });
    expect(status("lib_tiny").byJob.get(jSkip.id)?.wait).toBe("stuck");
  });

  it("18. send: from silent Mac -> offline; Mac polling without taking -> stuck after 10 min; Mac taking it -> queued, then done", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-18");
    await report(mac.token, MAC_MACHINE);

    const vSend = addVersion({
      sourceKey: "mac:18",
      macPath: "/Users/tiny/send18.mov",
      macDevice: mac.device.id,
      described: false,
    });
    const jSend = enqueue("lib_tiny", vSend, "send");

    // 1) Mac silent -> grey "Mac Studio is offline", not counted as queued work left
    const snapOffline = status("lib_tiny");
    expect(snapOffline.byJob.get(jSend.id)).toEqual({
      wait: "offline",
      reason: "Mac Studio is offline",
      device: mac.device.id,
      devices: [mac.device.id],
      actor: "tiny",
    });
    expect(snapOffline.waitingIds).toEqual([jSend.id]);
    expect(snapOffline.queuedIds).toEqual([]);

    // 2) Mac polling -> queued initially, then stuck "Mac Studio hasn't started on these" after 10 min
    await pollWait(mac.token, { blobs: true, work: 1 });
    vi.advanceTimersByTime(FRESH_MS);
    notePoll(mac.device.id, Date.now());
    const snapQueued = status("lib_tiny");
    expect(snapQueued.byJob.get(jSend.id)).toMatchObject({ wait: "queued", actor: "tiny" });
    expect(snapQueued.queuedIds).toEqual([jSend.id]);
    expect(snapQueued.waitingIds).toEqual([]);

    for (let m = 1; m <= 10; m++) {
      vi.advanceTimersByTime(60_000);
      notePoll(mac.device.id, Date.now());
    }
    const snapStuck = status("lib_tiny");
    expect(snapStuck.byJob.get(jSend.id)).toEqual({
      wait: "stuck",
      reason: "Mac Studio hasn't started on these",
      device: mac.device.id,
      actor: "tiny",
    });
    expect(snapStuck.waitingIds).toEqual([jSend.id]);
    expect(snapStuck.queuedIds).toEqual([]);

    // 3) Mac claims and finishes its send -> claimed, then done
    const claimed = await claimWork(mac.token);
    expect(claimed.lib?.job.id).toBe(jSend.id);
    expect(claimed.lib?.job.kind).toBe("send");

    vi.setSystemTime(Date.now() + FRESH_MS);
    const snapWhileClaimed = status("lib_tiny");
    // While running, jSend is no longer in waitingIds or queuedIds
    expect(snapWhileClaimed.byJob.has(jSend.id)).toBe(false);
    expect(snapWhileClaimed.waitingIds).toEqual([]);

    const probe = {
      duration: 10,
      format: "mov,mp4,m4a,3gp,3g2,mj2",
      vcodec: "h264",
      pixFmt: "yuv420p",
      acodec: "aac",
      width: 1920,
      height: 1080,
      fps: 30,
      rotation: 0,
    };
    const doneRes = await app.request(`/api/devices/relay/work/lib/${jSend.id}/done`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mac.token}`,
        "content-type": "application/json",
        "x-ct-claim": claimed.lib!.job.claim!,
      },
      body: JSON.stringify({
        outcome: { ok: true },
        files: [],
        probe,
        sha256: "a".repeat(64),
        quick: "b".repeat(64),
      }),
    });
    expect(doneRes.status).toBe(200);
    expect(await doneRes.json()).toEqual({ ok: true });

    const rowAfter = libraryDb().prepare("SELECT state FROM jobs WHERE id = ?").get(jSend.id) as { state: string };
    expect(rowAfter.state).toBe("done");

    vi.setSystemTime(Date.now() + FRESH_MS);
    const snapDone = status("lib_tiny");
    expect(snapDone.byJob.has(jSend.id)).toBe(false);
    expect(snapDone.waitingIds).toEqual([]);
  });

  // ---- CT-3c: progress() reads the status, and the devices list carries each computer's line ----

  /** progress() for `user` and the Activity rows it makes. */
  async function shown(user = "tiny") {
    const p = await progress("lib_tiny", user);
    const rows = appRows({ libraries: [{ id: "lib_tiny", uploading: null, progress: p }], edits: [], exports: [] });
    return { p, rows, ready: rows.filter((r) => r.state === "ready") };
  }
  /** A Linux box that claimed with its share as a footage folder, and a proxy of a file on that share. */
  async function linuxTaker(tag: string) {
    const linux = pairDevice("tiny", "Linux box", undefined, `hw-linux-${tag}`);
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    writeFolders("tiny", [{ id: `fld_${tag}`, name: `Share${tag}`, role: "footage", origin: { host: linux.device.id, path: `/mnt/footage/Share${tag}` }, reach: {} }]);
    return linux;
  }

  it("progress: a job a computer will take is work left whatever its line; the hook unset keeps today's rule; a taken job is not waiting", async () => {
    const { WAITS_FOR_COMPUTER } = await import("../library/jobs");
    await linuxTaker("p1");
    const v = addVersion({ sourcePath: "/mnt/footage/Sharep1/clip.mov" });
    const job = enqueue("lib_tiny", v, "proxy");
    // the lane wrote today's line before the box claimed
    libraryDb().prepare("UPDATE jobs SET error = ? WHERE id = ?").run(WAITS_FOR_COMPUTER, job.id);

    const a = await shown();
    expect(a.p.waiting).toEqual([]);
    expect(a.p.left).toBe(1);
    expect(a.rows.map((r) => [r.detail, r.state])).toEqual([["Preparing 1 clip · 0%", "working"]]);

    // no status (a server without the work road): the error text decides, as before
    const hook = leaveToComputers.status;
    leaveToComputers.status = undefined;
    try {
      const b = await shown();
      expect(b.p.left).toBe(0);
      expect(b.p.waiting).toEqual([{ step: "files", count: 1, missing: WAITS_FOR_COMPUTER, away: true }]);
      expect(b.rows.map((r) => [r.detail, r.reason, r.state])).toEqual([["1 file", "Waits for one of your computers", "working"]]);
    } finally {
      leaveToComputers.status = hook;
    }

    // a status that throws keeps today's rule too
    leaveToComputers.status = () => {
      throw new Error("broken");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await shown()).p.waiting).toEqual([{ step: "files", count: 1, missing: WAITS_FOR_COMPUTER, away: true }]);
    } finally {
      leaveToComputers.status = hook;
      warn.mockRestore();
    }

    // classified waiting, then taken before the next snapshot: not counted as waiting
    libraryDb().prepare("UPDATE jobs SET error = NULL WHERE id = ?").run(job.id);
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-p1");
    const vMac = addVersion({ fromPath: "/Users/tiny/p1.mov", fromDevice: mac.device.id });
    const jMac = enqueue("lib_tiny", vMac, "proxy");
    resetWaitsForTest(Date.now() - 20 * 60_000);
    expect(status("lib_tiny").byJob.get(jMac.id)?.wait).toBe("offline");
    libraryDb().prepare("UPDATE jobs SET state = 'running', held_by = ? WHERE id = ?").run(mac.device.id, jMac.id);
    const c = await shown();
    expect(c.p.waiting).toEqual([]);
    expect(c.p.left).toBe(2);
  });

  it("progress: offline, stuck and set groups carry the class and reason; MAC_WAITS looks are work left, never 'need an AI provider'", async () => {
    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-p2");
    await report(mac.token, MAC_MACHINE);
    const v1 = addVersion({ fromPath: "/Users/tiny/a.mov", fromDevice: mac.device.id });
    const v2 = addVersion({ fromPath: "/Users/tiny/b.mov", fromDevice: mac.device.id });
    enqueue("lib_tiny", v1, "proxy");
    enqueue("lib_tiny", v2, "proxy");
    const vl = addVersion({ sourceKey: "mac:p2", macPath: "/Users/tiny/l.mov", macDevice: mac.device.id });
    const look = enqueue("lib_tiny", vl, "look");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, look.id);

    // the Mac silent: one grey working row per step, never Waiting on you, nothing left
    const off = await shown();
    expect(off.p.left).toBe(0);
    expect(off.p.waiting).toEqual([
      { step: "files", count: 2, missing: "Mac Studio is offline", away: true, wait: "offline", reason: "Mac Studio is offline", mine: true, device: mac.device.id, devices: [mac.device.id] },
      { step: "look", count: 1, missing: "Mac Studio is offline", away: true, wait: "offline", reason: "Mac Studio is offline", mine: true, device: mac.device.id, devices: [mac.device.id] },
    ]);
    expect(off.rows.map((r) => [r.detail, r.reason, r.state, r.mark])).toEqual([
      ["2 files", "Mac Studio is offline", "working", "waits"],
      ["1 shot description", "Mac Studio is offline", "working", "waits"],
    ]);
    expect(off.ready).toEqual([]);

    // the Mac polls: everything is work left, the look counted as not through
    await pollWait(mac.token, { blobs: true, editor: [LIBRARY_LOOK_KIND], work: 1 });
    resetWaitsForTest(Date.now() - 20 * 60_000);
    notePoll(mac.device.id, Date.now());
    const on = await shown();
    expect(on.p.waiting).toEqual([]);
    expect(on.p.left).toBe(3);
    expect(on.p.clips).toBe(3);
    expect(on.p.share).toBeLessThan(1);
    expect(on.rows.map((r) => r.detail)).toEqual(["Preparing 3 clips · 0%"]);

    // still polling, never taking, for 10 min: a red working line naming the Mac, never Waiting on you
    for (let m = 1; m <= 11; m++) {
      vi.advanceTimersByTime(60_000);
      notePoll(mac.device.id, Date.now());
      checkWaits(Date.now());
    }
    const stuck = await shown();
    const files = stuck.p.waiting.find((w) => w.step === "files");
    expect(files).toMatchObject({ count: 2, away: true, wait: "stuck", reason: "Mac Studio hasn't started on these", mine: true, device: mac.device.id });
    expect(stuck.rows.find((r) => r.detail === "2 files")).toMatchObject({ reason: "Mac Studio hasn't started on these", mark: "stuck", state: "working" });
    expect(stuck.ready).toEqual([]);

    // an old app: a grey "Update" line, still not Waiting on you
    setDeviceWork(mac.device.id, { ...deviceOf(mac.device.id)!.work!, v: 0 });
    resetWaitsForTest(Date.now() - 20 * 60_000);
    const set = await shown();
    expect(set.p.waiting.find((w) => w.step === "files")).toMatchObject({ count: 2, wait: "set", reason: "Update Creator Toolset on Mac Studio" });
    expect(set.ready).toEqual([]);
  });

  it("progress: another person's waits read 'Your owner keeps…' and name a computer only when it is offline", async () => {
    const annaMac = pairDevice("anna", "Anna Mac", "0.17.6", "hw-anna-p3");
    await report(annaMac.token, MAC_MACHINE);
    const v = addVersion({ user: "anna", lib: "lib_tiny", macPath: "/Users/anna/c.mov", macDevice: annaMac.device.id });
    const job = enqueue("lib_tiny", v, "look", "tiny");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, job.id);

    const forTiny = await shown("tiny");
    expect(forTiny.p.waiting).toEqual([
      {
        step: "look",
        count: 1,
        missing: "Your owner keeps its files on their computers · Anna Mac is offline",
        away: true,
        wait: "offline",
        reason: "Your owner keeps its files on their computers · Anna Mac is offline",
        mine: false,
      },
    ]);
    expect(forTiny.ready).toEqual([]);
    expect((await shown("anna")).p.waiting[0]).toMatchObject({ reason: "Anna Mac is offline", mine: true, device: annaMac.device.id });

    // stuck for anna's computer: tiny sees no computer name
    await pollWait(annaMac.token, { blobs: true, editor: [LIBRARY_LOOK_KIND], work: 1 });
    resetWaitsForTest(Date.now() - 20 * 60_000);
    for (let m = 1; m <= 11; m++) {
      vi.advanceTimersByTime(60_000);
      notePoll(annaMac.device.id, Date.now());
      checkWaits(Date.now());
    }
    const w = (await shown("tiny")).p.waiting;
    expect(w).toEqual([expect.objectContaining({ wait: "stuck", reason: ownerKeeps(), mine: false })]);
    expect(JSON.stringify(w)).not.toContain("Anna Mac");
  });

  it("20. invariant: no ready row while an able computer is allowed (queued, busy, stuck, offline, send, looks)", async () => {
    const noReady = async () => expect((await shown()).ready).toEqual([]);
    const linux = await linuxTaker("20");
    const vq = addVersion({ sourcePath: "/mnt/footage/Share20/q.mov" });
    enqueue("lib_tiny", vq, "proxy");
    await noReady(); // queued
    const vb = addVersion({ sourcePath: "/mnt/footage/Share20/b.mov" });
    enqueue("lib_tiny", vb, "proxy");
    expect((await claimWork(linux.token, { libraryOnly: true })).lib).toBeTruthy();
    resetWaitsForTest(Date.now() - 20 * 60_000);
    await noReady(); // busy

    const mac = pairDevice("tiny", "Mac Studio", "0.17.6", "hw-mac-20");
    await report(mac.token, MAC_MACHINE);
    const vs = addVersion({ sourceKey: "mac:20", macPath: "/Users/tiny/s.mov", macDevice: mac.device.id, described: false });
    enqueue("lib_tiny", vs, "send");
    const vl = addVersion({ sourceKey: "mac:20l", macPath: "/Users/tiny/l.mov", macDevice: mac.device.id });
    const look = enqueue("lib_tiny", vl, "look");
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE id = ?").run(MAC_WAITS, look.id);
    resetWaitsForTest(Date.now() - 20 * 60_000);
    await noReady(); // send and look of an offline Mac

    await pollWait(mac.token, { blobs: true, editor: [LIBRARY_LOOK_KIND], work: 1 });
    resetWaitsForTest(Date.now() - 20 * 60_000);
    notePoll(mac.device.id, Date.now());
    await noReady(); // the Mac asks
    for (let m = 1; m <= 11; m++) {
      vi.advanceTimersByTime(60_000);
      notePoll(mac.device.id, Date.now());
      await claimWork(linux.token, { libraryOnly: true }).catch(() => null);
      checkWaits(Date.now());
    }
    await noReady(); // stuck
    expect((await shown()).p.waiting.some((w) => w.wait === "stuck")).toBe(true);
  });

  it("21. Computers row: a refused box online through another caller says 'Add … again', Activity says the same; a newer row, a powered-off box, a busy box, low disk and Off say nothing", async () => {
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tiny", password: "password1" }) });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const devicesList = async () =>
      json<{ id: string; name: string; waits?: { line: string; tone: string } }[]>(app.request("/api/devices", { headers: { cookie } }));
    const waitsOf = async (id: string) => (await devicesList()).find((d) => d.id === id)?.waits;

    const linux = await linuxTaker("21");
    const v = addVersion({ sourcePath: "/mnt/footage/Share21/c.mov" });
    enqueue("lib_tiny", v, "proxy");
    // 16 min on, the adopting helper's polls (no `work`) keep the row online
    vi.advanceTimersByTime(16 * 60_000);
    await pollWait(linux.token, { blobs: false, editor: [] }, "python-requests/2.31");
    resetWaitsForTest(Date.now() - 30 * 60_000);
    expect(await waitsOf(linux.device.id)).toEqual({ line: "Add Linux box again in Settings → Computers", tone: "needs" });
    const a = await shown();
    expect(a.p.waiting).toEqual([expect.objectContaining({ wait: "offline", reason: "Add Linux box again in Settings → Computers" })]);
    expect(a.rows.map((r) => [r.detail, r.reason])).toEqual([["1 file", "Add Linux box again in Settings → Computers"]]);

    // low disk: claims with lowDisk keep it from reading refused
    setDeviceWork(linux.device.id, { ...deviceOf(linux.device.id)!.work!, lowDisk: true, lowDiskAt: Date.now() });
    resetWaitsForTest(Date.now() - 30 * 60_000);
    expect(await waitsOf(linux.device.id)).toBeUndefined();
    expect((await shown()).p.waiting[0]).toMatchObject({ reason: "Linux box is short of disk space" });
    const { lowDisk: _l, lowDiskAt: _a, ...work } = deviceOf(linux.device.id)!.work!;
    setDeviceWork(linux.device.id, work);

    // Off in Load balancing: nothing on the row
    await writeBalance("tiny", { on: true, weights: { [linux.device.id]: 0 }, libraries: {}, originals: {} });
    resetWaitsForTest(Date.now() - 30 * 60_000);
    expect(await waitsOf(linux.device.id)).toBeUndefined();
    await writeBalance("tiny", { on: true, weights: {}, libraries: {}, originals: {} });

    // a second row of the same box claiming fresh has taken over: nothing
    const again = pairDevice("tiny", "Linux box", undefined, "hw-linux-21-new");
    await claimWork(again.token, { libraryOnly: true });
    expect(await waitsOf(linux.device.id)).toBeUndefined();
    await revokeDevice(again.device.id);

    // 30 min into a job: busy, nothing
    libraryDb().prepare("UPDATE jobs SET state = 'running', held_by = ? WHERE version_id = ?").run(linux.device.id, v);
    expect(await waitsOf(linux.device.id)).toBeUndefined();
    libraryDb().prepare("UPDATE jobs SET state = 'queued', held_by = NULL WHERE version_id = ?").run(v);

    // powered off: no calls for 16 min -> offline, no line on the row
    vi.advanceTimersByTime(16 * 60_000);
    resetWaitsForTest(Date.now() - 30 * 60_000);
    expect(await waitsOf(linux.device.id)).toBeUndefined();
    expect((await shown()).p.waiting[0]).toMatchObject({ wait: "offline", reason: "Linux box is offline" });

    // a stuck line on the Computers row (tone stuck)
    stuckOn.set(linux.device.id, "Linux box hasn't taken these yet");
    expect(await waitsOf(linux.device.id)).toEqual({ line: "Linux box hasn't taken these yet", tone: "stuck" });
    stuckOn.clear();
  });

  it("23. a hold on one job keeps the box's free clock; a look claim never makes a library worker busy; a description takes its transcript's class", async () => {
    const linux = pairDevice("tiny", "Linux box", undefined, "hw-linux-23");
    await report(linux.token, LINUX_MACHINE, "node");
    await claimWork(linux.token, { libraryOnly: true });
    await post(linux.token, "/api/devices/relay/editor/claim", { kinds: [LIBRARY_LOOK_KIND] }, "node");
    expect(called.has(linux.device.id)).toBe(false);
    writeFolders("tiny", [
      { id: "fld_23", name: "Share23", role: "footage", origin: { host: linux.device.id, path: "/mnt/footage/Share23" }, reach: {} },
    ]);
    // a server-held proxy first: the box (originals off) is held noOriginals for it
    const held = enqueue("lib_tiny", addVersion({}), "proxy");
    const mine = enqueue("lib_tiny", addVersion({ sourcePath: "/mnt/footage/Share23/a.mov" }), "proxy");
    const vWords = addVersion({ sourcePath: "/mnt/footage/Share23/b.mov", proxy: true, described: false });
    const words = enqueue("lib_tiny", vWords, "transcribe");
    const desc = enqueue("lib_tiny", vWords, "describe");
    since.set(mine.id, Date.now() - STUCK_MS);
    freeSince.set(linux.device.id, Date.now() - STUCK_MS);
    const snap = status("lib_tiny");
    expect(snap.byJob.get(held.id)?.wait).not.toBe("stuck");
    expect(snap.byJob.get(mine.id)).toMatchObject({ wait: "stuck", device: linux.device.id });
    expect(freeSince.get(linux.device.id)).toBe(Date.now() - STUCK_MS);
    expect(snap.byJob.get(desc.id)).toEqual(snap.byJob.get(words.id));
  });
});
