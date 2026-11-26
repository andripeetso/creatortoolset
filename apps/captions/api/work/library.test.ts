import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { WORK_V, type LibraryPackage } from "../../contracts/work";
import type { JobRow } from "../library/jobs";

// two sides in one process: the server's routes, and a computer's worker that calls them through `fetch`
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-library-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { libraryDb } = await import("../library/db");
const { createUser } = await import("../users");
const { sessionCookieFor } = await import("../auth");
createUser("tiny", "secret-tiny-acrobatics");
/** The iPhone app's own upload: its header and its session (routes.ts isAppSession), which a browser's lacks. */
const PHONE = () => ({ "x-ct-origin": "phone", cookie: sessionCookieFor("tiny", true)! });
const { libraryApp } = await import("../library/routes");
const { tick } = await import("../library/worker");
const { sha256File } = await import("../lib/uploads");
const { deviceOf, devicesSaved, listDevices, pairDevice, setDeviceWork } = await import("../lib/devices");
const { writeBalance } = await import("../lib/balance");
const { CLAIM_POLL, workApp } = await import("./routes");
const { computerTakesLibrary, libraryWaitLine } = await import("./library-package");
const { foldersOf } = await import("../editor/reach");
const { unreachedShares } = await import("../../contracts/storage");
const { LIBRARY_HERE, makeDerived, runLibraryJob } = await import("./library");
const { writeServerWork } = await import("./server-work");
const { WAITS_FOR_COMPUTER, enqueueJob, requeueExpired } = await import("../library/jobs");
const { cutStills } = await import("../library/describe");
const { blobs } = await import("../library/db");
const { quickPrint } = await import("./files");
const { proxyPath, setCacheAccount } = await import("./cache");

CLAIM_POLL.holdMs = 0;

const app = new Hono<{ Variables: AuthVars }>();
app.use("/api/library/*", async (c, next) => {
  c.set("user", { username: "tiny", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/devices/relay/work", workApp);

const d = libraryDb();
for (const [id, upload, proxy] of [["lib_p", "proxies", true], ["lib_all", "all", true], ["lib_phone", "proxies", true], ["lib_none", "none", true], ["lib_hosted_off", "proxies", false]] as const) {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tiny', 'Tiny Acrobatics', 'local', ?, 0)").run(
    id,
    JSON.stringify({ upload, proxy, describe: false, embed: false }),
  );
}

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
/** A camera original: 1080p, near lossless, with sound. Its proxy (720p, CRF 26) is a small part of it. */
const camera = (name: string, size = "1920x1080") => {
  const out = path.join(dir, "Movies", name);
  mkdirSync(path.dirname(out), { recursive: true });
  ff(["-f", "lavfi", "-i", `testsrc2=duration=2:size=${size}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-vf", "noise=alls=20:allf=t", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
  return out;
};

let mac: ReturnType<typeof pairDevice>;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const MAC = { os: "mac", cpus: 12, memGb: 32, freeGb: 16, load: 0.1 };
const claimAs = async (token: string, more: Record<string, unknown> = {}) =>
  (await (await post("/api/devices/relay/work/claim", { v: WORK_V, steps: [], library: true, ...more }, { authorization: `Bearer ${token}` })).json()) as { pkg: null; lib?: LibraryPackage };
const claim = () => claimAs(mac.token, { machine: MAC });

/** What the computer sent and fetched, by call. */
let puts: { name: string; bytes: number }[] = [];
let gets: string[] = [];
const o = (token = mac.token) => ({
  server: "http://server.test",
  token,
  beatMs: 50,
  fetch: (u: string, i?: RequestInit) => {
    const url = new URL(u);
    if (i?.method === "PUT") puts.push({ name: url.searchParams.get("name")!, bytes: Number((i.headers as Record<string, string>)["content-length"]) });
    else if (!i?.method || i.method === "GET") gets.push(url.pathname.split("/").pop()!);
    return Promise.resolve(app.request(u, i));
  },
});

const version = (id: string) =>
  d.prepare("SELECT source_key, mac_path, mac_device, sha256, quick, probe, state FROM asset_versions WHERE id = ?").get(id) as {
    source_key: string;
    mac_path: string | null;
    mac_device: string | null;
    sha256: string;
    quick: string | null;
    probe: string | null;
    state: string;
  };
const derived = (id: string) =>
  Object.fromEntries((d.prepare("SELECT kind, bytes FROM derivatives WHERE version_id = ?").all(id) as { kind: string; bytes: number }[]).map((r) => [r.kind, r.bytes]));
const jobs = (id: string) => (d.prepare("SELECT kind, state FROM jobs WHERE version_id = ? ORDER BY id").all(id) as { kind: string; state: string }[]).map((j) => `${j.kind}:${j.state}`);
const MADE = ["thumb", "wave", "proxy", "sprite", "fingerprint"];

/** The Mac app's page sending `file` from this computer (src/lib/library.ts uploadFile, send). */
async function send(lib: string, file: string) {
  const r = await post(`/api/library/${lib}/uploads`, {
    filename: path.basename(file),
    size: statSync(file).size,
    fromPath: file,
    fromDevice: mac.device.id,
    quick: await quickPrint(file),
    send: true,
  });
  return (await r.json()) as { sent?: true; versionId: string; id?: string };
}

beforeAll(async () => {
  mac = pairDevice("tiny", "Studio Mac");
  setCacheAccount("tiny"); // its worker learns it from the claim answer
  expect(await claim()).toEqual({ pkg: null, account: "tiny" }); // its worker says it runs library jobs
});
afterAll(async () => {
  await devicesSaved();
  rmSync(dir, { recursive: true, force: true });
});

describe("library work on the computer that has the file", () => {
  it("PRD test 5: a proxies-only library gets about the proxy's bytes, never the original", async () => {
    puts = [];
    const file = camera("tiny-flip.mp4");
    const size = statSync(file).size;
    const r = await send("lib_p", file);
    expect(r.sent).toBe(true);
    // recorded at once, waiting for that computer; nothing here reads a file it doesn't have
    expect(version(r.versionId)).toMatchObject({ source_key: `mac:${r.versionId}`, mac_path: file, mac_device: mac.device.id });
    expect(jobs(r.versionId)).toEqual(["send:queued"]);
    expect(computerTakesLibrary(d.prepare("SELECT * FROM jobs WHERE version_id = ?").get(r.versionId) as never)).toBe(true);

    const { lib } = await claim();
    expect(lib?.job.kind).toBe("send");
    expect(lib?.file.path).toBe(file);
    expect(await runLibraryJob(lib!, o())).toBe("done");

    const sent = puts.reduce((n, p) => n + p.bytes, 0);
    const got = derived(r.versionId);
    expect(puts.map((p) => p.name)).not.toContain("original");
    expect(gets).toEqual([]); // the file was read where it is: nothing downloaded
    expect(got.proxy).toBeGreaterThan(0);
    expect(got.proxy).toBeLessThan(size / 3);
    // the bytes sent are the proxy and the small files (picture, waveform, strip): about the proxy's size
    expect(sent - got.proxy!).toBeLessThan(400_000);
    expect(sent).toBeLessThan(size / 2);
    console.log(`[PRD test 5] original ${size} B, proxy ${got.proxy} B, sent ${sent} B`);

    const v = version(r.versionId);
    expect(v.source_key).toBe(`libraries/lib_p/v/${r.versionId}/proxy.mp4`);
    expect(v.mac_path).toBe(file); // the original stays where it is on that Mac
    expect(v.sha256).toBe(await sha256File(file));
    expect(v.quick).toBe(await quickPrint(file)); // Locate finds the original by it once it moves
    expect(JSON.parse(v.probe!)).toMatchObject({ width: 1920, height: 1080 });
    expect(v.state).toBe("ready");
    expect(Object.keys(got).sort()).toEqual([...MADE].sort());
    // nothing it sent is made again on the server; what reads words still runs there
    expect(jobs(r.versionId).filter((j) => MADE.some((k) => j.startsWith(`${k}:`)))).toEqual([]);
    expect(jobs(r.versionId)).toContain("transcribe:queued");
  }, 60_000);

  it("hosting alone makes nothing: Upload → Proxies with Generate proxies off sends no proxy and no original", async () => {
    puts = [];
    const r = await send("lib_hosted_off", camera("tiny-hosted-off.mp4"));
    const { lib } = await claim();
    expect(lib?.job).toMatchObject({ kind: "send", versionId: r.versionId });
    expect(lib).toMatchObject({ upload: "proxies", proxy: { on: false, cloud: false } });
    expect(await runLibraryJob(lib!, o())).toBe("done");
    for (const name of ["proxy", "original"]) expect(puts.map((p) => p.name), name).not.toContain(name);
    expect(version(r.versionId).source_key).toBe(`mac:${r.versionId}`); // still the file on its Mac, nothing of it kept here
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(r.versionId); // what its send queued next is not the next tests' to claim
  }, 60_000);

  it("a library that keeps originals gets the original too, and makes none of what came with it", async () => {
    puts = [];
    // over 1080 on its short side, to a library that makes proxies: the server would make one, but the computer did
    const file = camera("tiny-roll.mp4", "1440x1280");
    const r = await send("lib_all", file);
    const { lib } = await claim();
    expect(lib?.upload).toBe("all");
    expect(await runLibraryJob(lib!, o())).toBe("done");
    expect(puts.map((p) => p.name).sort()).toEqual(["original", "proxy", "sprite", "thumb", "wave"]);
    const v = version(r.versionId);
    expect(v.source_key).toBe(`libraries/lib_all/v/${r.versionId}/source`);
    expect(v.mac_path).toBeNull();
    expect(v.quick).toBe(await quickPrint(file));
    expect(v.state).toBe("ready");
    expect(Object.keys(derived(r.versionId)).sort()).toEqual([...MADE].sort());
    expect(jobs(r.versionId).filter((j) => MADE.some((k) => j.startsWith(`${k}:`)))).toEqual([]);
    expect(await tick(Date.now(), MADE)).toBe(false); // the server has none of them to make
  }, 60_000);

  it("a phone upload gets its proxy from a computer, which deletes the original it downloaded", async () => {
    puts = [];
    gets = [];
    // over 1080 on its short side: it needs a proxy; uploaded from a phone, so no computer has it
    const file = camera("tiny-phone.mp4", "1440x1280");
    const size = statSync(file).size;
    const start = (await (await post("/api/library/lib_phone/uploads", { filename: "tiny-phone.mp4", size }, PHONE())).json()) as { id: string };
    await app.request(`/api/library/uploads/${start.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(size) }, body: readFileSync(file) });
    const { versionId } = (await (await post(`/api/library/uploads/${start.id}/finish`, {})).json()) as { versionId: string };
    expect(await tick(Date.now(), ["probe"])).toBe(true);
    expect(jobs(versionId)).toEqual(expect.arrayContaining(["thumb:queued", "wave:queued", "proxy:queued", "sprite:queued", "fingerprint:queued"]));

    // the server leaves the proxy and what reads it to the computer; the card's picture it makes itself
    expect(await tick(Date.now(), ["proxy", "sprite", "fingerprint"])).toBe(false);
    expect(await tick(Date.now(), ["wave"])).toBe(false);
    expect(await tick(Date.now(), ["thumb"])).toBe(true);

    const first = await claim();
    expect(first.lib?.job.kind).toBe("proxy");
    expect(first.lib?.original).toEqual({ bytes: size });
    expect(first.lib?.file.path).toBeUndefined();
    const work = path.join(dir, "library-work", `${first.lib!.job.id}-${first.lib!.job.claim}`);
    expect(await runLibraryJob(first.lib!, o())).toBe("done");
    expect(gets).toEqual(["original"]);
    expect(existsSync(work)).toBe(false); // the downloaded original went with the job's folder
    expect(existsSync(proxyPath(versionId))).toBe(false); // and never landed in the proxy cache
    expect(derived(versionId).proxy).toBeGreaterThan(0);
    expect(version(versionId).source_key).toBe(`libraries/lib_phone/v/${versionId}/source`); // the server keeps its upload

    // the rest read the proxy the computer made, never the original again
    gets = [];
    const done: string[] = [];
    for (let lib = (await claim()).lib; lib; lib = (await claim()).lib) {
      expect(lib.original).toBeUndefined();
      expect(await runLibraryJob(lib, o())).toBe("done");
      done.push(lib.job.kind);
    }
    expect(done.sort()).toEqual(["fingerprint", "sprite", "wave"]);
    expect(gets.every((g) => g === "light")).toBe(true);
    expect(Object.keys(derived(versionId)).sort()).toEqual([...MADE].sort());
    expect(version(versionId).state).toBe("ready");
    expect(readdirSync(path.join(dir, "library-work"))).toEqual([]);
  }, 60_000);

  it("a phone upload with no proxy: its waveform, strip and fingerprint download the original rather than wait for a computer forever", async () => {
    puts = [];
    gets = [];
    const file = camera("tiny-small.mp4", "640x360");
    const size = statSync(file).size;
    const start = (await (await post("/api/library/lib_phone/uploads", { filename: "tiny-small.mp4", size }, PHONE())).json()) as { id: string };
    await app.request(`/api/library/uploads/${start.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(size) }, body: readFileSync(file) });
    const { versionId } = (await (await post(`/api/library/uploads/${start.id}/finish`, {})).json()) as { versionId: string };
    expect(await tick(Date.now(), ["probe"])).toBe(true);
    // a library that makes no proxy for it (its switch off, or none smaller than the file): none on its way
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'proxy'").run(versionId);
    expect(await tick(Date.now(), ["thumb"])).toBe(true);
    // no computer has it and there is no proxy to read: the computer downloads the original for each (once nothing could)
    expect(await tick(Date.now(), ["sprite", "fingerprint", "wave"])).toBe(false);
    // a description's stills too: a Finals file is one the server holds with no proxy (no transcript to wait for)
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'transcribe'").run(versionId);
    enqueueJob(d, "lib_phone", versionId, "describe", "tiny", true);
    expect(await tick(Date.now(), ["describe"])).toBe(false);
    const done: string[] = [];
    const now = () => claimAs(mac.token, { machine: MAC, libraryKinds: LIBRARY_HERE });
    for (let lib = (await now()).lib; lib; lib = (await now()).lib) {
      expect(lib.original).toEqual({ bytes: size });
      // the server describes from the stills (no AI here): the computer's part is done once they are sent
      await runLibraryJob(lib, o());
      done.push(lib.job.kind);
    }
    expect(done.sort()).toEqual(["describe", "fingerprint", "sprite", "wave"]);
    // the stills reached the server, which asks the AI (none in this test: parked for one)
    expect(d.prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'describe'").get(versionId)).toEqual({ state: "needs_key" });
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'describe'").run(versionId);
    expect((await claim()).lib).toBeUndefined(); // the Mac claims as the other tests' older app again
    expect(gets.every((g) => g === "original")).toBe(true);
    expect(readdirSync(path.join(dir, "library-work"))).toEqual([]); // each downloaded original went with its job's folder
  }, 60_000);

  it("a Linux computer that takes only library work: its machine block, the libraries it takes, originals only where allowed, Off is off", async () => {
    const linux = pairDevice("tiny", "Linux box");
    const LINUX = { os: "linux", cpus: 32, memGb: 64, freeGb: 60, load: 0, disks: [{ path: "/mnt/tiny", name: "tiny", freeGb: 900, network: true, server: "tiny-nas", fs: "smb", share: "TINY FOOTAGE" }] };
    const asLinux = () => claimAs(linux.token, { libraryOnly: true, machine: LINUX });
    expect(await asLinux()).toEqual({ pkg: null, account: "tiny" });
    const seen = deviceOf(linux.device.id)!;
    expect(seen.work).toMatchObject({ library: true, libraryOnly: true, steps: [] });
    expect(seen.report?.machine).toMatchObject({ os: "linux", cpus: 32, disks: [{ path: "/mnt/tiny", share: "TINY FOOTAGE" }] });

    const file = camera("tiny-phone-2.mp4", "1600x1280");
    const size = statSync(file).size;
    const start = (await (await post("/api/library/lib_phone/uploads", { filename: "tiny-phone-2.mp4", size }, PHONE())).json()) as { id: string };
    await app.request(`/api/library/uploads/${start.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(size) }, body: readFileSync(file) });
    const { versionId } = (await (await post(`/api/library/uploads/${start.id}/finish`, {})).json()) as { versionId: string };
    expect(await tick(Date.now(), ["probe"])).toBe(true);
    const mine = { on: true, weights: { [mac.device.id]: 0 } };
    await writeBalance("tiny", mine);
    // the Mac is Off: it takes nothing, even with no other computer that could
    expect((await claim()).lib).toBeUndefined();
    // the proxy needs the original downloaded: not on a computer whose originals are off (the default off a Mac)
    expect((await asLinux()).lib).toBeUndefined();
    // a library not on its list: never
    await writeBalance("tiny", { ...mine, originals: { [linux.device.id]: true }, libraries: { [linux.device.id]: ["lib_p"] } });
    expect((await asLinux()).lib).toBeUndefined();
    await writeBalance("tiny", { ...mine, originals: { [linux.device.id]: true }, libraries: { [linux.device.id]: ["lib_phone"] } });
    // another account's computer is never handed this account's job, whatever it says it is
    const stranger = pairDevice("stranger", "Stranger's box");
    await writeBalance("stranger", { on: true, weights: {}, originals: { [stranger.device.id]: true } });
    expect((await claimAs(stranger.token, { libraryOnly: true, machine: LINUX })).lib).toBeUndefined();
    const got = (await asLinux()).lib!;
    expect(got.job).toMatchObject({ kind: "proxy", versionId });
    expect(await runLibraryJob(got, o(linux.token))).toBe("done");
    expect(derived(versionId).proxy).toBeGreaterThan(0);
    await writeBalance("tiny", { on: true, weights: {} });
  }, 60_000);

  it("a computer without the share is told which folder it can't read; once it reports the share it reads the clip there, not a copy", async () => {
    const box = pairDevice("tiny", "Tiny box");
    const SHARE = { name: "TINY FOOTAGE", freeGb: 900, network: true, server: "tiny-nas", fs: "smb", share: "TINY FOOTAGE" };
    const mnt = path.join(dir, "mnt", "tiny"); // its own mount path, not the Mac's
    const BOX = { os: "linux", cpus: 32, memGb: 64, freeGb: 60, load: 0 };
    // the Mac added SHOOTS on its share, and sent a clip from it; then it went Off
    await claimAs(mac.token, { machine: { ...MAC, disks: [{ ...SHARE, path: "/Volumes/TINY FOOTAGE" }] } });
    mkdirSync(path.join(dir, "storage"), { recursive: true });
    writeFileSync(path.join(dir, "storage", "tiny.json"), JSON.stringify({ folders: [{ id: "shoots", role: "footage", name: "SHOOTS", origin: { host: mac.device.id, path: "/Volumes/TINY FOOTAGE/SHOOTS" }, make: false, createdAt: 0, reach: {} }] }));
    const file = camera("tiny-share.mp4", "1152x648"); // not the bytes of the other 1280x720 clips here (a duplicate would not be made)
    const onShare = path.join(mnt, "SHOOTS", "day 1", "tiny-share.mp4");
    mkdirSync(path.dirname(onShare), { recursive: true });
    copyFileSync(file, onShare);
    const size = statSync(file).size;
    const start = (await (await post("/api/library/lib_all/uploads", { filename: "tiny-share.mp4", size, fromPath: "/Volumes/TINY FOOTAGE/SHOOTS/day 1/tiny-share.mp4", fromDevice: mac.device.id, quick: await quickPrint(file) })).json()) as { id: string };
    await app.request(`/api/library/uploads/${start.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(size) }, body: readFileSync(file) });
    const { versionId } = (await (await post(`/api/library/uploads/${start.id}/finish`, {})).json()) as { versionId: string };
    expect(await tick(Date.now(), ["probe"])).toBe(true);
    const others = Object.fromEntries(listDevices((x) => x.owner === "tiny" && x.id !== box.device.id).map((x) => [x.id, 0]));
    await writeBalance("tiny", { on: true, weights: others, libraries: { [box.device.id]: ["lib_all"] } });
    const wave = () => d.prepare("SELECT * FROM jobs WHERE version_id = ? AND kind = 'wave'").get(versionId) as unknown as JobRow;

    // no share on it: nothing it can take, and the wait line names the folder and the share to connect
    expect((await claimAs(box.token, { libraryOnly: true, machine: { ...BOX, disks: [] } })).lib).toBeUndefined();
    expect(libraryWaitLine(wave())).toBe("No computer can read SHOOTS: connect TINY FOOTAGE on Tiny box");
    expect(unreachedShares(foldersOf("tiny"), box.device.id)).toEqual(["TINY FOOTAGE"]);

    // its next claim reports the share: the line is gone, and it reads the clip where it is on the share (rank 3)
    const withShare = () => claimAs(box.token, { libraryOnly: true, machine: { ...BOX, disks: [{ ...SHARE, path: mnt }] } });
    gets = [];
    let lib = (await withShare()).lib;
    expect(unreachedShares(foldersOf("tiny"), box.device.id)).toEqual([]);
    let got: LibraryPackage | undefined;
    for (; lib; lib = (await withShare()).lib) {
      if (lib.job.versionId === versionId && lib.job.kind === "wave") got = lib;
      expect(lib.file.path).toBe(onShare);
      expect(await runLibraryJob(lib, o(box.token))).toBe("done");
    }
    expect(got).toBeDefined();
    expect(gets.filter((g) => g === "light" || g === "original")).toEqual([]); // nothing downloaded
    expect(derived(versionId).wave).toBeGreaterThan(0);
    await writeBalance("tiny", { on: true, weights: {} });
    rmSync(path.join(dir, "storage", "tiny.json"));
  }, 60_000);

  it("a job parked for a computer is taken once one comes online: its away line goes, and the claim gets it", async () => {
    const { WAITS_FOR_COMPUTER, enqueueJob } = await import("../library/jobs");
    const { progress } = await import("../library/estimate");
    const id = "ver_park";
    d.exec(`
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_park', 'lib_p', 'video', 'park', 'tiny', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device) VALUES
        ('${id}', 'ast_park', 1, 'mac:${id}', 1, 'x', 'ready', 'tiny', 0, '/Users/tiny/Movies/park.mp4', '${mac.device.id}');
    `);
    enqueueJob(d, "lib_p", id, "wave", "tiny");
    const job = () => d.prepare("SELECT * FROM jobs WHERE version_id = ? AND kind = 'wave'").get(id) as unknown as JobRow & { held_by: string | null };
    const awayCount = async () => (await progress("lib_p", "tiny")).waiting.filter((w) => w.away).reduce((n, w) => n + w.count, 0);
    // parked while no computer was there: the line says so, and the Activity counts it as away
    d.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(WAITS_FOR_COMPUTER, job().id);
    const before = await awayCount();
    // the Mac is online (its claim is fresh): the server leaves the job to it and clears the old line
    await tick(Date.now(), ["wave"]);
    expect(job()).toMatchObject({ state: "queued", error: null });
    // the computers' status (work/waits.ts) counted it as work left already, the Mac's claim being fresh, whatever its old line
    expect(await awayCount()).toBe(before);
    // and the Mac's next claim takes it
    let got: LibraryPackage | undefined;
    for (let i = 0; i < 30 && !got; i++) {
      const lib = (await claimAs(mac.token, { machine: MAC })).lib;
      if (!lib) break;
      if (lib.job.versionId === id) got = lib;
    }
    expect(got?.job.kind).toBe("wave");
    expect(job()).toMatchObject({ state: "running", held_by: mac.device.id });
  });
});

/** A phone's upload of `file` to `lib`: the server holds the original, no computer has it. */
async function phoneUpload(lib: string, file: string): Promise<string> {
  const size = statSync(file).size;
  const start = (await (await post(`/api/library/${lib}/uploads`, { filename: path.basename(file), size }, lib === "lib_phone" ? PHONE() : {})).json()) as { id: string };
  await app.request(`/api/library/uploads/${start.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(size) }, body: readFileSync(file) });
  return ((await (await post(`/api/library/uploads/${start.id}/finish`, {})).json()) as { versionId: string }).versionId;
}

describe("a proxy kept on this computer while its Download location's disk is not connected (docs/media-library-proxies-prd.md R9)", () => {
  it("none is made: nothing is downloaded or sent, and the job says what it needs", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const lib = {
      v: WORK_V,
      job: { id: 7, kind: "proxy", versionId: "v1", libraryId: "lib", actor: "tiny" },
      file: { id: "v1", title: "clip.mov", bytes: 10 },
      folders: [],
      original: { bytes: 10 },
      keepProxy: true,
    } as LibraryPackage;
    process.env.CT_PROXY_DIR = "/Volumes/ct-test-no-such-disk/Creator Toolset Downloads/studio";
    try {
      const out = await runLibraryJob(lib, {
        server: "http://server.test",
        token: "ctd_test",
        beatMs: 60_000,
        fetch: (u: string, i?: RequestInit) => {
          calls.push({ path: new URL(u).pathname.replace(/^.*\/work\//, ""), body: typeof i?.body === "string" ? JSON.parse(i.body) : undefined });
          return Promise.resolve(Response.json({ ok: true }));
        },
      });
      expect(out).toBe("failed");
      expect(calls).toEqual([{ path: "lib/7/fail", body: { error: "Needs the Download location's disk" } }]);
    } finally {
      delete process.env.CT_PROXY_DIR;
    }
  });
});

describe("local-first P3f: a probe, a card picture and a description's stills with the server's video work off", () => {
  it("they wait for a computer with the wait line, nothing runs here, and the computer makes what the server made", async () => {
    const file = camera("tiny-p3f.mp4", "1280x720");
    // the server's own run, video work on: the reference
    const here = await phoneUpload("lib_all", file);
    expect(await tick(Date.now(), ["probe"])).toBe(true);
    expect(await tick(Date.now(), ["thumb"])).toBe(true);
    const thumbOf = async (lib: string, v: string) => readFileSync(await blobs.localCopy(`libraries/${lib}/v/${v}/thumb.jpg`));

    writeServerWork({ on: false });
    try {
      const v = await phoneUpload("lib_phone", file);
      const probeJob = () => d.prepare("SELECT state, error FROM jobs WHERE version_id = ? AND kind = 'probe'").get(v) as { state: string; error: string | null };
      // no computer that runs probes yet (an older one names no later kinds): it waits, saying so, and nothing ran here
      expect(await tick(Date.now(), ["probe"])).toBe(false);
      expect(probeJob()).toEqual({ state: "queued", error: WAITS_FOR_COMPUTER });
      expect(version(v).probe).toBeNull();
      expect(derived(v)).toEqual({});

      // a computer that runs them: it probes the original (downloaded, then deleted with the job) and makes the card picture
      const done: string[] = [];
      for (let lib = (await claim2()).lib; lib; lib = (await claim2()).lib) {
        expect(await runLibraryJob(lib, o())).toBe("done");
        done.push(lib.job.kind);
      }
      expect(done).toEqual(expect.arrayContaining(["probe", "thumb"]));
      expect(readdirSync(path.join(dir, "library-work"))).toEqual([]); // the originals it downloaded went with each job
      expect(JSON.parse(version(v).probe!)).toEqual(JSON.parse(version(here).probe!));
      expect(version(v).quick).toBe(await quickPrint(file));
      expect((await thumbOf("lib_phone", v)).equals(await thumbOf("lib_all", here))).toBe(true);
      expect(await tick(Date.now(), ["probe", "thumb"])).toBe(false); // nothing left for the server

      // a description's stills: the computer's cut is the server's (describe.ts cutStills), so the AI is shown the same
      const lib = { v: WORK_V, job: { id: 1, kind: "describe", versionId: v, libraryId: "lib_phone", actor: "tiny" }, file: { id: v, title: "t", bytes: 0 }, probe: JSON.parse(version(v).probe!) } as LibraryPackage;
      const a = mkdtempSync(path.join(dir, "stills-")), b = mkdtempSync(path.join(dir, "stills-"));
      const made = await makeDerived(lib, file, a);
      const server = await cutStills(file, JSON.parse(version(v).probe!).duration, 0, b);
      expect(Object.keys(made.files)).toEqual(server.map((_, i) => `still${i}`));
      server.forEach((f, i) => expect(readFileSync((made.files as Record<string, string>)[`still${i}`]!).equals(readFileSync(f))).toBe(true));
    } finally {
      writeServerWork({ on: true, v: 2 });
    }
  }, 120_000);
});

/** A claim of a computer whose worker runs every library kind (work/library.ts LIBRARY_HERE). */
const claim2 = () => claimAs(mac.token, { machine: MAC, libraryKinds: LIBRARY_HERE });

describe("a computer's add before its first library claim", () => {
  const add = async (lib: string, file: string, fromDevice: string) =>
    post(`/api/library/${lib}/uploads`, { filename: path.basename(file), size: statSync(file).size, fromPath: file, fromDevice, quick: await quickPrint(file), send: true });

  it("a freshly paired Mac (a poll's version, no library mark) sends: the file stays on it, no original bytes are taken", async () => {
    const fresh = pairDevice("tiny", "Fresh Mac");
    setDeviceWork(fresh.device.id, { v: WORK_V, steps: [] }); // what a poll stamps; only a claim marks a library taker
    const file = camera("tiny-fresh.mp4", "1024x576"); // its own bytes: the same render would be a duplicate
    const r = (await (await add("lib_p", file, fresh.device.id)).json()) as { sent?: true; versionId: string };
    expect(r.sent).toBe(true);
    expect(version(r.versionId)).toMatchObject({ source_key: `mac:${r.versionId}`, mac_path: file, mac_device: fresh.device.id });
    expect(jobs(r.versionId)).toEqual(["send:queued"]);
    // Upload none: nothing is sent and the original is refused (the Mac app indexes it in place)
    const none = await add("lib_none", file, fresh.device.id);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { code: string }).code).toBe("upload_refused");
  });

  it("an unregistered client's original is refused under proxies and under none (UNIFIED-PRD §4.2)", async () => {
    const file = camera("tiny-stranger.mp4", "848x480");
    expect((await add("lib_p", file, "not-a-device")).status).toBe(409);
    expect((await add("lib_none", file, "not-a-device")).status).toBe(409);
  });
});

describe("G4: a lease follows a transfer's progress, and a box short of disk or too old blocks nobody", () => {
  afterEach(() => vi.useRealTimers());
  const MIN = 60_000;
  let n = 0;
  /** A job `device` holds under claim `claim`, as a claim leaves it. */
  const heldJob = (device: string, claimId: string): number => {
    const v = `ver_g4_${++n}`;
    d.exec(`
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_${v}', 'lib_p', 'video', '${v}', 'tiny', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('${v}', 'ast_${v}', 1, 'k_${v}', 1, 'x', 'ready', 'tiny', 0);
    `);
    const { lastInsertRowid } = d
      .prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, attempts, lease_until, held_by, claim_id) VALUES ('lib_p', ?, 'proxy', 'running', 'tiny', 1, ?, ?, ?)")
      .run(v, Date.now() + 300_000, device, claimId);
    return Number(lastInsertRowid);
  };
  const lease = (id: number) => (d.prepare("SELECT lease_until FROM jobs WHERE id = ?").get(id) as { lease_until: number | null }).lease_until;
  const beat = (id: number, body: unknown, claimId = "c27", token = mac.token) =>
    post(`/api/devices/relay/work/lib/${id}/beat`, body, { authorization: `Bearer ${token}`, "x-ct-claim": claimId });
  /** Beats every minute for `minutes`, each body from `at(minute)`; whether every beat kept the lease ahead of now. */
  const beats = async (id: number, minutes: number, at: (m: number) => unknown) => {
    for (let m = 1; m <= minutes; m++) {
      vi.setSystemTime(Date.now() + MIN);
      expect((await beat(id, at(m))).status).toBe(200);
      if (lease(id) !== Date.now() + 300_000) return false;
    }
    return true;
  };

  it("PRD 27: moving bytes keep it; bytes frozen below the total for 15 min let it lapse, and the next beat is 410", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const moving = heldJob(mac.device.id, "c27");
    expect(await beats(moving, 40, (m) => ({ line: "Downloading", done: m * 1000, total: 1e9 }))).toBe(true);

    const frozen = heldJob(mac.device.id, "c27");
    expect(await beats(frozen, 14, () => ({ done: 500, total: 1000 }))).toBe(true);
    expect(await beats(frozen, 2, () => ({ done: 500, total: 1000 }))).toBe(false);
    vi.setSystemTime(lease(frozen)! + 1);
    requeueExpired(d);
    expect(d.prepare("SELECT state, attempts FROM jobs WHERE id = ?").get(frozen)).toEqual({ state: "queued", attempts: 1 });
    expect((await beat(frozen, { done: 500, total: 1000 })).status).toBe(410);
  });

  it("PRD 27: a finished upload the server checks, beats with no progress, and the first beat after a restart renew", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const checking = heldJob(mac.device.id, "c27");
    expect(await beats(checking, 20, () => ({ done: 1000, total: 1000 }))).toBe(true);
    const encoding = heldJob(mac.device.id, "c27");
    expect(await beats(encoding, 40, () => ({ line: "Making the proxy" }))).toBe(true);
    // nothing in memory for it (as after a restart): the first beat with progress renews
    const fresh = heldJob(mac.device.id, "c27");
    vi.setSystemTime(Date.now() + 4 * MIN);
    await beat(fresh, { done: 10, total: 1000 });
    expect(lease(fresh)).toBe(Date.now() + 300_000);
  });

  it("PRD 27: the unit does not restart a refused worker (78) but does an update (3), and starts again on a new token", () => {
    const unit = readFileSync(new URL("../../scripts/ct-library-worker.service", import.meta.url), "utf8");
    const line = unit.split("\n").filter((l) => l.startsWith("RestartPreventExitStatus="));
    expect(line).toEqual(["RestartPreventExitStatus=78"]);
    expect(unit).toMatch(/^Restart=always$/m);
    const watch = readFileSync(new URL("../../scripts/ct-library-worker-env.path", import.meta.url), "utf8");
    expect(watch).toMatch(/^PathChanged=%h\/\.config\/ct-library-worker\.env$/m);
    expect(readFileSync(new URL("../../scripts/ct-library-worker-env.service", import.meta.url), "utf8")).toMatch(/restart ct-library-worker\.service/);
  });

  it("PRD 9b: a low-disk claim and an update answer stamp no `at`; a box too old gets no library package, its editor steps still come", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const box = pairDevice("tiny", "Tiny Box");
    const LINUX = { os: "linux", cpus: 32, memGb: 64, freeGb: 400, load: 0 };
    const work = () => deviceOf(box.device.id)!.work!;
    await claimAs(box.token, { libraryOnly: true, machine: LINUX });
    const { at, libraryAt } = work();
    expect(libraryAt).toBe(at);

    vi.setSystemTime(Date.now() + MIN);
    expect(await claimAs(box.token, { libraryOnly: true, lowDisk: true })).toEqual({ pkg: null });
    expect(work()).toMatchObject({ at, libraryAt, lowDisk: true, lowDiskAt: Date.now() });
    vi.setSystemTime(Date.now() + MIN);
    await claimAs(box.token, { libraryOnly: true, lowDisk: true });
    expect(work()).toMatchObject({ at, libraryAt, lowDiskAt: Date.now() });
    await claimAs(box.token, { libraryOnly: true, machine: LINUX });
    expect(work().lowDisk).toBeUndefined();
    expect(work().at).toBe(Date.now());

    // a package newer than it reads, handed back: too old from now on, and its restarts are told to update, stamping nothing
    const held = heldJob(box.device.id, "cb");
    expect(await (await post(`/api/devices/relay/work/lib/${held}/fail`, { error: "This computer needs a newer Creator Toolset", update: true }, { authorization: `Bearer ${box.token}`, "x-ct-claim": "cb" })).json()).toEqual({ ok: true });
    expect(work().tooOld).toBe(WORK_V);
    const before = work().at;
    vi.setSystemTime(Date.now() + MIN);
    expect(await claimAs(box.token, { libraryOnly: true, machine: LINUX })).toEqual({ pkg: null, update: true, account: "tiny" });
    expect(work().at).toBe(before);
    // a newer worker drops the mark
    await claimAs(box.token, { libraryOnly: true, machine: LINUX, v: WORK_V + 1 });
    expect(work().tooOld).toBeUndefined();
    expect(work().libraryAt).toBe(Date.now());

    // a job handed back for its Download location's disk waits: no try is counted, the clip is not failed, and it comes back later
    const waits = heldJob(box.device.id, "cd");
    expect(await (await post(`/api/devices/relay/work/lib/${waits}/fail`, { error: "Needs the Download location's disk" }, { authorization: `Bearer ${box.token}`, "x-ct-claim": "cd" })).json()).toEqual({ ok: true });
    const after = d.prepare("SELECT j.state, j.attempts, j.run_after, v.state AS clip FROM jobs j JOIN asset_versions v ON v.id = j.version_id WHERE j.id = ?").get(waits) as { state: string; attempts: number; run_after: number; clip: string };
    expect(after).toMatchObject({ state: "queued", attempts: 0, clip: "ready" });
    expect(after.run_after).toBeGreaterThan(Date.now());

    // a worker that also takes editor steps: stamped (its steps still come) but no library package, until it is newer
    const other = pairDevice("tiny", "Tiny Laptop");
    const v = "ver_g4_mine";
    d.exec(`
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_${v}', 'lib_p', 'video', 'mine', 'tiny', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device) VALUES
        ('${v}', 'ast_${v}', 1, 'mac:${v}', 1, 'x', 'ready', 'tiny', 0, '/Users/tiny/Movies/mine.mp4', '${other.device.id}');
    `);
    enqueueJob(d, "lib_p", v, "wave", "tiny");
    // as the hand-back above leaves a worker's row
    setDeviceWork(other.device.id, { v: WORK_V, steps: [], library: true, tooOld: WORK_V });
    vi.setSystemTime(Date.now() + MIN);
    const got = await claimAs(other.token, { machine: MAC });
    expect(got.lib).toBeUndefined();
    expect((got as { update?: true }).update).toBeUndefined();
    expect(deviceOf(other.device.id)!.work).toMatchObject({ at: Date.now(), tooOld: WORK_V, library: true });
    expect(deviceOf(other.device.id)!.work!.libraryAt).toBeUndefined();
    // newer: it takes library packages again, its own file's among them
    let mine: LibraryPackage | undefined;
    for (let i = 0; i < 30 && !mine; i++) {
      const lib = (await claimAs(other.token, { machine: MAC, v: WORK_V + 1 })).lib;
      if (!lib) break;
      if (lib.job.versionId === v) mine = lib;
    }
    expect(mine?.job.kind).toBe("wave");
  });
});

describe("a photo goes only to a computer that reads its card picture with no seek", () => {
  it("an older worker (no stills) is never handed it; one with the fix is", async () => {
    d.exec("UPDATE jobs SET state = 'done' WHERE state IN ('queued', 'running')"); // what the tests above left
    const r = await send("lib_p", camera("tiny-still.mp4", "320x240"));
    expect(jobs(r.versionId)).toEqual(["send:queued"]);
    // a photo on this Mac, as a folder listing files it (a proxies library takes no upload of one)
    d.prepare("UPDATE assets SET kind = 'image' WHERE current_version_id = ?").run(r.versionId);
    expect((await claim()).lib).toBeUndefined();
    const { lib } = await claimAs(mac.token, { machine: MAC, stills: true });
    expect(lib?.job.versionId).toBe(r.versionId);
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ?").run(r.versionId);
  });
});
