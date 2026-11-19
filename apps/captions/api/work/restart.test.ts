import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { WORK_V, type LibraryPackage } from "../../contracts/work";

// A library job a computer holds outlives a restart of the server (PRD S3): the holder is on the job's row, a restart
// gives it a whole lease, the computer keeps going while the server is away, a 410 stops it and its ffmpeg at once.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-restart-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { devicesSaved, pairDevice } = await import("../lib/devices");
// the computer's side: loaded once, as a computer's worker is its own process
const { runLibraryJob } = await import("./library");
const { stopForExit } = await import("./computer");
const { setCacheAccount } = await import("./cache");

const { createUser } = await import("../users");
const { sessionCookieFor } = await import("../auth");
createUser("tiny", "secret-tiny-acrobatics");
/** The iPhone app's own upload: its header and its session (routes.ts isAppSession). */
const PHONE = () => ({ "x-ct-origin": "phone", cookie: sessionCookieFor("tiny", true)! });

/** The server's side, loaded again for each "restart": nothing it held in memory survives one. */
async function boot() {
  const { libraryDb } = await import("../library/db");
  const { graceHeld, requeueExpired } = await import("../library/jobs");
  const { libraryApp } = await import("../library/routes");
  const { tick } = await import("../library/worker");
  const { CLAIM_POLL, workApp } = await import("./routes");
  CLAIM_POLL.holdMs = 0;
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("/api/library/*", async (c, next) => {
    c.set("user", { username: "tiny", role: "user" } as never);
    return next();
  });
  app.route("/api/library", libraryApp);
  app.route("/api/devices/relay/work", workApp);
  graceHeld(libraryDb(), 300); // as startLibraryWorker does at a server's start
  return { app, db: libraryDb(), tick, requeueExpired };
}
let srv = await boot();
async function restart() {
  await devicesSaved();
  vi.resetModules();
  srv = await boot();
}

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
/** A phone clip over 1080 on its short side (it needs a proxy), long enough that its proxy takes a while. */
const clip = (name: string, pattern: string) => {
  const out = path.join(dir, "Phone", name);
  mkdirSync(path.dirname(out), { recursive: true });
  ff(["-f", "lavfi", "-i", `${pattern}=duration=60:size=1440x1280:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
  return out;
};

let mac: ReturnType<typeof pairDevice>;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  srv.app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const claim = async () =>
  (await (await post("/api/devices/relay/work/claim", { v: WORK_V, steps: [], library: true }, { authorization: `Bearer ${mac.token}` })).json()) as { lib?: LibraryPackage };
const beat = (lib: LibraryPackage, claimId = lib.job.claim) =>
  post(`/api/devices/relay/work/lib/${lib.job.id}/beat`, {}, { authorization: `Bearer ${mac.token}`, ...(claimId ? { "x-ct-claim": claimId } : {}) });

/** While true, the server answers nothing: it is restarting. */
let away = false;
const o = (giveUpMs = 60_000) => ({
  server: "http://server.test",
  token: mac.token,
  beatMs: 50,
  retryMs: 50,
  giveUpMs,
  fetch: (u: string, i?: RequestInit) => (away ? Promise.reject(new Error("connect ECONNREFUSED")) : Promise.resolve(srv.app.request(u, i))),
});

const job = (id: number) => srv.db.prepare("SELECT state, attempts, error, held_by, claim_id FROM jobs WHERE id = ?").get(id) as { state: string; attempts: number; error: string | null; held_by: string | null; claim_id: string | null };
/** The ffmpeg processes writing into `folder` (a job's scratch). */
const ffmpegIn = (folder: string) =>
  execFileSync("ps", ["-ww", "-eo", "args"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes("ffmpeg") && l.includes(folder));
const until = async (ok: () => boolean, ms = 30_000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const scratchOf = (lib: LibraryPackage) => path.join(dir, "library-work", `${lib.job.id}-${lib.job.claim}`);

/** A phone upload to the library, probed and its card made: its proxy is left for the computer. */
async function upload(file: string): Promise<string> {
  const size = statSync(file).size;
  const start = (await (await post("/api/library/lib_t/uploads", { filename: path.basename(file), size }, PHONE())).json()) as { id: string };
  await srv.app.request(`/api/library/uploads/${start.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(size) }, body: readFileSync(file) });
  const { versionId } = (await (await post(`/api/library/uploads/${start.id}/finish`, {})).json()) as { versionId: string };
  expect(await srv.tick(Date.now(), ["probe"])).toBe(true);
  expect(await srv.tick(Date.now(), ["thumb"])).toBe(true);
  return versionId;
}

beforeAll(async () => {
  srv.db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_t', 'tiny', 'Tiny Acrobatics', 'local', ?, 0)").run(
    JSON.stringify({ upload: "proxies", proxy: true, describe: false, embed: false }),
  );
  mac = pairDevice("tiny", "Studio Mac");
  setCacheAccount("tiny"); // its worker learns it from the claim answer
  expect((await claim()).lib).toBeUndefined(); // its worker says it runs library jobs
});
afterAll(async () => {
  await devicesSaved();
  rmSync(dir, { recursive: true, force: true });
});

describe("a library job on a computer across restarts", () => {
  let versionId = "";

  it("a 410 drops the job at once and kills its ffmpeg", async () => {
    versionId = await upload(clip("tiny-flip.mp4", "testsrc2"));
    const { lib } = await claim();
    expect(lib?.job.kind).toBe("proxy");
    expect(lib?.job.claim).toMatch(/^[\w-]{36}$/);
    const run = runLibraryJob(lib!, o());
    await until(() => ffmpegIn(scratchOf(lib!)).length > 0); // the proxy is being made
    // the server takes it back meanwhile (its lease ran out): the next beat is answered 410
    srv.db.prepare("UPDATE jobs SET lease_until = 0 WHERE id = ?").run(lib!.job.id);
    expect(srv.requeueExpired(srv.db)).toBe(1);
    expect((await beat(lib!)).status).toBe(410);
    const t0 = Date.now();
    expect(await run).toBe("stopped");
    expect(Date.now() - t0).toBeLessThan(6000); // SIGTERM, else SIGKILL after 5 s
    expect(ffmpegIn(scratchOf(lib!))).toEqual([]);
    expect(existsSync(scratchOf(lib!))).toBe(false);
    // nothing sent: the try is the claim's, as for any lease that ran out
    expect(job(lib!.job.id)).toMatchObject({ state: "queued", attempts: 1 });
  }, 120_000);

  it("a restart between beats keeps the holder, and the result made across it is taken", async () => {
    const { lib } = await claim();
    expect(lib?.job.kind).toBe("proxy");
    expect(job(lib!.job.id)).toMatchObject({ state: "running", attempts: 2, held_by: mac.device.id, claim_id: lib!.job.claim });
    expect((await beat(lib!, "an-earlier-claim")).status).toBe(410); // the first claim's late calls count for nothing
    const run = runLibraryJob(lib!, o());
    await until(() => ffmpegIn(scratchOf(lib!)).length > 0);
    // the server goes away; it comes back after the job's lease ran out, as a slow restart would leave it
    away = true;
    srv.db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(Date.now() - 1, lib!.job.id);
    await new Promise((r) => setTimeout(r, 300)); // beats unanswered: the computer keeps going
    await restart();
    expect(srv.requeueExpired(srv.db)).toBe(0); // the start gave the held job its lease again
    away = false;
    expect((await beat(lib!)).status).toBe(200);
    expect(await run).toBe("done");
    expect(job(lib!.job.id)).toMatchObject({ state: "done", attempts: 2, error: null });
    expect(srv.db.prepare("SELECT bytes FROM derivatives WHERE version_id = ? AND kind = 'proxy'").get(versionId)).toMatchObject({ bytes: expect.any(Number) });
    expect(existsSync(scratchOf(lib!))).toBe(false);
  }, 120_000);

  it("a result without the file its kind makes fails the try, never finishes", async () => {
    const { lib } = await claim();
    expect(lib?.job.kind).toBe("wave");
    const auth = { authorization: `Bearer ${mac.token}`, "x-ct-claim": lib!.job.claim! };
    const res = await post(`/api/devices/relay/work/lib/${lib!.job.id}/done`, { v: WORK_V, outcome: { done: true }, files: [] }, auth);
    expect(await res.json()).toEqual({ ok: false });
    expect(job(lib!.job.id)).toMatchObject({ state: "queued", attempts: 1, error: "Your computer's wave did not arrive" });
    expect(srv.db.prepare("SELECT 1 FROM derivatives WHERE version_id = ? AND kind = 'wave'").get(versionId)).toBeUndefined();
    // and a computer that sees its file refused sends no result: the try fails, the job is made again
    srv.db.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").run(lib!.job.id);
    const again = (await claim()).lib!;
    expect(again.job.id).toBe(lib!.job.id);
    const refuse = { ...o(), fetch: (u: string, i?: RequestInit) => (i?.method === "PUT" ? Promise.resolve(new Response("{}", { status: 400 })) : o().fetch(u, i)) };
    expect(await runLibraryJob(again, refuse)).toBe("failed");
    expect(job(lib!.job.id)).toMatchObject({ state: "queued", attempts: 2, error: "The server refused the wave (400)" });
  }, 60_000);

  it("a stop of the worker (SIGTERM) kills the job's ffmpeg and waits for it", async () => {
    await upload(clip("tiny-roll.mp4", "smptehdbars"));
    let lib: LibraryPackage | undefined;
    while ((lib = (await claim()).lib) && lib.job.kind !== "proxy") srv.db.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(lib.job.id);
    expect(lib?.job.kind).toBe("proxy");
    const run = runLibraryJob(lib!, o());
    await until(() => ffmpegIn(scratchOf(lib!)).length > 0);
    await stopForExit(10_000);
    expect(ffmpegIn(scratchOf(lib!))).toEqual([]);
    expect(await run).toBe("stopped");
    expect(job(lib!.job.id)).toMatchObject({ state: "queued", error: "Stopped" });
  }, 120_000);

  it("a server away past the lease less a minute: the computer gives the job up", async () => {
    srv.db.prepare("UPDATE jobs SET state = 'queued', run_after = 0, attempts = 0 WHERE kind = 'proxy' AND state <> 'done'").run();
    const { lib } = await claim();
    expect(lib?.job.kind).toBe("proxy");
    const run = runLibraryJob(lib!, o(200));
    await until(() => ffmpegIn(scratchOf(lib!)).length > 0);
    away = true;
    expect(await run).toBe("stopped");
    away = false;
    expect(ffmpegIn(scratchOf(lib!))).toEqual([]);
    expect(job(lib!.job.id)).toMatchObject({ state: "running", held_by: mac.device.id }); // its lease puts it back
  }, 120_000);
});
