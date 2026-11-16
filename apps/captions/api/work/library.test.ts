import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { WORK_V, type LibraryPackage } from "../../contracts/work";

// two sides in one process: the server's routes, and a computer's worker that calls them through `fetch`
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-library-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { libraryDb } = await import("../library/db");
const { libraryApp } = await import("../library/routes");
const { tick } = await import("../library/worker");
const { sha256File } = await import("../lib/uploads");
const { devicesSaved, pairDevice } = await import("../lib/devices");
const { CLAIM_POLL, workApp } = await import("./routes");
const { computerTakesLibrary } = await import("./library-package");
const { runLibraryJob } = await import("./library");
const { quickPrint } = await import("./files");
const { proxyPath } = await import("./cache");

CLAIM_POLL.holdMs = 0;

const app = new Hono<{ Variables: AuthVars }>();
app.use("/api/library/*", async (c, next) => {
  c.set("user", { username: "tiny", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/devices/relay/work", workApp);

const d = libraryDb();
for (const [id, upload, proxy] of [["lib_p", "proxies", false], ["lib_all", "all", true], ["lib_phone", "none", true]] as const) {
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
const claim = async () =>
  (await (await post("/api/devices/relay/work/claim", { v: WORK_V, steps: [], library: true }, { authorization: `Bearer ${mac.token}` })).json()) as { pkg: null; lib?: LibraryPackage };

/** What the computer sent and fetched, by call. */
let puts: { name: string; bytes: number }[] = [];
let gets: string[] = [];
const o = () => ({
  server: "http://server.test",
  token: mac.token,
  beatMs: 50,
  fetch: (u: string, i?: RequestInit) => {
    const url = new URL(u);
    if (i?.method === "PUT") puts.push({ name: url.searchParams.get("name")!, bytes: Number((i.headers as Record<string, string>)["content-length"]) });
    else if (!i?.method || i.method === "GET") gets.push(url.pathname.split("/").pop()!);
    return Promise.resolve(app.request(u, i));
  },
});

const version = (id: string) =>
  d.prepare("SELECT source_key, mac_path, mac_device, sha256, probe, state FROM asset_versions WHERE id = ?").get(id) as {
    source_key: string;
    mac_path: string | null;
    mac_device: string | null;
    sha256: string;
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
  expect(await claim()).toEqual({ pkg: null }); // its worker says it runs library jobs
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
    expect(JSON.parse(v.probe!)).toMatchObject({ width: 1920, height: 1080 });
    expect(v.state).toBe("ready");
    expect(Object.keys(got).sort()).toEqual([...MADE].sort());
    // nothing it sent is made again on the server; what reads words still runs there
    expect(jobs(r.versionId).filter((j) => MADE.some((k) => j.startsWith(`${k}:`)))).toEqual([]);
    expect(jobs(r.versionId)).toContain("transcribe:queued");
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
    const start = (await (await post("/api/library/lib_phone/uploads", { filename: "tiny-phone.mp4", size })).json()) as { id: string };
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
    const work = path.join(dir, "library-work", String(first.lib!.job.id));
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
});
