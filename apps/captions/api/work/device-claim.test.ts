import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORK_V } from "../../contracts/work";
import type { JobRow } from "../library/jobs";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-claim-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "work-claim-test-secret";

// the package itself is item 4A's: here only which step goes where
vi.mock("./package", () => ({
  buildPackage: async (job: JobRow) => ({ v: 1, job: { id: job.id, kind: job.kind, editId: "", variant: "", actor: job.actor, workspaceId: "" }, edit: {}, own: [], rows: {}, files: [], caches: {}, ai: { editor: null, analyzer: null } }),
  ownFile: () => null,
}));

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb, blobs } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { deviceForToken, deviceOf, devicesSaved, pairDevice, setDeviceWork, touchDevice } = await import("../lib/devices");
const { releaseQuietDevices } = await import("../editor/engine");
const { waitLine } = await import("../editor/reach");
const { STEPS, tick } = await import("../editor/worker");
const { Waiting } = await import("../editor/analyze");
const { CLAIM_POLL } = await import("./routes");
const { gates, progressOf } = await import("./place");

CLAIM_POLL.holdMs = 0;

const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const post = (token: string, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = (token: string, v = WORK_V) => json<{ pkg: { job: { id: number }; gate?: unknown } | null; update?: true }>(post(token, "/api/devices/relay/work/claim", { v, steps: [] }));
const report = (token: string, machine: Record<string, unknown>) => post(token, "/api/devices/relay/report", { drivers: [], homes: [], machine });
const BIG = { os: "linux", cpus: 32, memGb: 64, freeGb: 48, load: 0.05 };
const SMALL = { os: "mac", cpus: 8, memGb: 16, freeGb: 4, load: 0.3 };

const cookies: Record<string, string> = {};
async function login(user: string) {
  setOff(createUser(user, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: "password1" }) });
  cookies[user] = res.headers.get("set-cookie")!.split(";")[0]!;
}
/** A library of `user`'s with one file: on a computer (`on`), and/or uploaded with a proxy. */
function file(user: string, id: string, at: { on?: string; uploaded?: boolean }) {
  libraryDb().exec(`
    INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_${user}', '${user}', 'L', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_${id}', 'lib_${user}', 'video', '${id}', '${user}', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device) VALUES
      ('${id}', 'ast_${id}', 1, '${at.uploaded ? `k_${id}` : `mac:${id}`}', 1, 'x', 'ready', '${user}', 0, ${at.on ? `'/Users/tiny/Movies/${id}.mp4', '${at.on}'` : "NULL, NULL"});
    ${at.uploaded ? `INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('${id}', 'proxy', 'p_${id}', 1);` : ""}
  `);
}
async function newEdit(user: string, sources: string[]): Promise<string> {
  const id = (await json<{ id: string }>(app.request("/api/editor", { method: "POST", headers: { cookie: cookies[user]!, "content-type": "application/json" }, body: JSON.stringify({ name: "Cut", sources }) }))).id;
  libraryDb().exec("DELETE FROM edit_jobs"); // whatever creating it queued: each test queues its own steps
  return id;
}
const queue = (user: string, editId: string, variant: string, kind = "preview") => enqueueJob(libraryDb(), user, `${editId}:${variant}`, kind, user, false, "edit_jobs");
const row = (editId: string, variant: string, kind = "preview") =>
  libraryDb().prepare("SELECT * FROM edit_jobs WHERE version_id = ? AND kind = ?").get(`${editId}:${variant}`, kind) as unknown as JobRow;
const settle = () => libraryDb().exec("UPDATE edit_jobs SET state = 'done', device = NULL WHERE state IN ('queued', 'running')");

let laptop: ReturnType<typeof pairDevice>;
let pc: ReturnType<typeof pairDevice>;

beforeAll(async () => {
  for (const u of ["maker", "other", "solo", "old", "loop", "fresh"]) await login(u);
  laptop = pairDevice("maker", "Laptop");
  pc = pairDevice("maker", "Big PC");
  // the PC is far roomier: balancing alone would always pick it
  await report(pc.token, BIG);
  await report(laptop.token, SMALL);
  // each worker says it is there once (nothing waits yet)
  expect(await claim(pc.token)).toEqual({ pkg: null, account: "maker" });
  expect(await claim(laptop.token)).toEqual({ pkg: null, account: "maker" });
  file("maker", "ver_lap", { on: laptop.device.id, uploaded: true });
  file("maker", "ver_up", { uploaded: true });
});
afterAll(async () => {
  await devicesSaved();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(rootReplaced)("a step that reads video goes to one of the asker's own computers", () => {
  it("the computer that has the files takes it, though a stronger one could download the proxies", async () => {
    const e = await newEdit("maker", ["ver_lap"]);
    queue("maker", e, "v1");
    expect((await claim(pc.token)).pkg).toBeNull();
    expect((await claim(laptop.token)).pkg?.job.id).toBe(row(e, "v1").id);
    expect(row(e, "v1")).toMatchObject({ state: "running", device: laptop.device.id });
  });

  it("files on neither: balancing picks the stronger one", async () => {
    settle();
    const e = await newEdit("maker", ["ver_up"]);
    queue("maker", e, "v1");
    expect((await claim(laptop.token)).pkg).toBeNull();
    expect((await claim(pc.token)).pkg?.job.id).toBe(row(e, "v1").id);
  });

  it("the footage route sends the proxy of an uploaded original, the original only where the library uploads originals", async () => {
    const job = libraryDb().prepare("SELECT id FROM edit_jobs WHERE device = ? AND state = 'running'").get(pc.device.id) as { id: number };
    for (const [key, text] of [["k_ver_up", "the original"], ["p_ver_up", "the proxy"]] as const) {
      const f = path.join(dir, `${key}.mp4`);
      writeFileSync(f, text);
      await blobs.put(key, f);
    }
    const get = (q = "") => app.request(`/api/devices/relay/editor/job/${job.id}/footage/ver_up${q}`, { headers: { authorization: `Bearer ${pc.token}` } });
    expect(await (await get()).text()).toBe("the proxy");
    expect(await (await get("?original=1")).text()).toBe("the proxy");
    libraryDb().exec(`UPDATE libraries SET settings = '{"upload":"all"}' WHERE id = 'lib_maker'`);
    expect(await (await get("?original=1")).text()).toBe("the original");
    expect(await (await get()).text()).toBe("the proxy");
    libraryDb().exec(`UPDATE libraries SET settings = '{}' WHERE id = 'lib_maker'`);
    // only the computer that holds the step
    expect((await app.request(`/api/devices/relay/editor/job/${job.id}/footage/ver_up`, { headers: { authorization: `Bearer ${laptop.token}` } })).status).toBe(404);
  });

  it("a beat keeps the lease and the progress, and says when the step is no longer held", async () => {
    const job = libraryDb().prepare("SELECT id FROM edit_jobs WHERE device = ? AND state = 'running'").get(pc.device.id) as { id: number };
    expect(await json(post(pc.token, `/api/devices/relay/work/${job.id}/beat`, { line: "Downloading proxies", done: 10, total: 40, leftS: 3 }))).toEqual({ ok: true });
    expect(progressOf(job.id)).toMatchObject({ device: "Big PC", line: "Downloading proxies", done: 10, total: 40, leftS: 3 });
    expect(await json(post(laptop.token, `/api/devices/relay/work/${job.id}/beat`, {}))).toEqual({ ok: false });
    settle();
    expect(await json(post(pc.token, `/api/devices/relay/work/${job.id}/beat`, {}))).toEqual({ ok: false });
    expect(progressOf(job.id)).toBeUndefined();
  });

  it("a computer set to Off takes nothing while the other can", async () => {
    mkdirSync(path.join(dir, "balance"), { recursive: true });
    writeFileSync(path.join(dir, "balance", "maker.json"), JSON.stringify({ on: true, weights: { [pc.device.id]: 0 } }));
    const e = await newEdit("maker", ["ver_up"]);
    queue("maker", e, "v1");
    expect((await claim(pc.token)).pkg).toBeNull();
    expect((await claim(laptop.token)).pkg?.job.id).toBe(row(e, "v1").id);
    rmSync(path.join(dir, "balance", "maker.json"));
  });

  it("never another account's step", async () => {
    settle();
    const theirs = pairDevice("other", "Their PC");
    await report(theirs.token, BIG);
    const e = await newEdit("maker", ["ver_up"]);
    queue("maker", e, "v1");
    expect((await claim(theirs.token)).pkg).toBeNull();
    expect(row(e, "v1").state).toBe("queued");
  });

  it("the device runner's long poll says a step waits, so the app starts its worker", async () => {
    // the step queued above waits for the maker's computers
    expect(await json(post(pc.token, "/api/devices/relay/wait", { editor: [] }))).toEqual({ work: true });
    settle();
  });

  it("a computer whose worker never claimed is told too, from the version its long poll sends", async () => {
    const fresh = pairDevice("fresh", "Fresh Mac");
    await report(fresh.token, BIG);
    file("fresh", "ver_fresh", { uploaded: true });
    const e = await newEdit("fresh", ["ver_fresh"]);
    queue("fresh", e, "v1");
    expect(await json(post(fresh.token, "/api/devices/relay/wait", { blobs: true, work: 1 }))).toEqual({ work: true });
    expect(deviceOf(fresh.device.id)?.work?.v).toBe(1);
    settle();
  });

  it("a poll never makes a computer a Media Library taker, and drops a taker mark no claim wrote", async () => {
    const mac = pairDevice("pollonly", "Poll Mac");
    // the device record is written as the poll comes in, before the poll waits for anything: look a moment later
    const poll = async () => {
      void Promise.resolve(post(mac.token, "/api/devices/relay/wait", { blobs: true, work: 1 })).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      return deviceOf(mac.device.id)?.work;
    };
    expect(await poll()).toMatchObject({ v: 1 });
    expect((await poll())?.library).toBeUndefined();
    setDeviceWork(mac.device.id, { v: 1, steps: [], library: true }); // a mark an earlier poll wrote: no claim time
    expect((await poll())?.library).toBeUndefined();
    setDeviceWork(mac.device.id, { v: 1, steps: [], library: true, at: Date.now() }); // a claim's mark stays
    expect((await poll())?.library).toBe(true);
  });


  it("a Mac re-paired under the same name keeps its id, so its folders and places still read", async () => {
    const first = pairDevice("again", "Again Mac");
    const second = pairDevice("again", "Again Mac");
    expect(second.device.id).toBe(first.device.id);
    expect(second.replaced).toEqual([]);
    expect(deviceForToken(`Bearer ${first.token}`)).toBeNull();
    expect(deviceForToken(`Bearer ${second.token}`)?.id).toBe(first.device.id);
    settle();
  });

  it("with no computer online the step says so in one line, and a computer that comes online takes it", async () => {
    const mac = pairDevice("solo", "Solo Mac");
    file("solo", "ver_solo", { uploaded: true });
    const e = await newEdit("solo", ["ver_solo"]);
    queue("solo", e, "v1");
    expect(waitLine("solo", row(e, "v1"))).toBe("Waits for one of your computers. Open Creator Toolset on your Mac");
    expect((await claim(mac.token)).pkg?.job.id).toBe(row(e, "v1").id);
  });

  it("a computer too old for the package takes nothing and is told to update", async () => {
    const mac = pairDevice("old", "Old Mac");
    file("old", "ver_old", { uploaded: true });
    const e = await newEdit("old", ["ver_old"]);
    queue("old", e, "v1");
    expect(await claim(mac.token, 0)).toEqual({ pkg: null, update: true, account: "old" });
    expect(deviceOf(mac.device.id)?.work?.v).toBe(0);
    expect(row(e, "v1").state).toBe("queued");
    expect(waitLine("old", row(e, "v1"))).toBe("Update Creator Toolset on Old Mac");
    settle();
  });

  it("a gate that waits puts its step back with its line, and the next step is claimed", async () => {
    const e = await newEdit("maker", ["ver_up"]);
    queue("maker", e, "v1");
    queue("maker", e, "v2");
    gates.preview = async ({ variant }) => {
      if (variant === "v1") throw new Waiting(120, "Waits for its transcript");
      return { heard: true };
    };
    try {
      const got = (await claim(pc.token)).pkg;
      expect(got).toMatchObject({ job: { id: row(e, "v2").id }, gate: { heard: true } });
      expect(row(e, "v1")).toMatchObject({ state: "queued", attempts: 0, error: "Waits for its transcript", device: null });
    } finally {
      delete gates.preview;
      settle();
    }
  });

  it("a computer that goes quiet gives its step back without counting the try; a reported crash counts", async () => {
    const e = await newEdit("maker", ["ver_up"]);
    queue("maker", e, "v1");
    const id = (await claim(pc.token)).pkg!.job.id;
    releaseQuietDevices(libraryDb(), () => false);
    expect(row(e, "v1")).toMatchObject({ state: "queued", attempts: 0, device: null });
    expect((await claim(pc.token)).pkg?.job.id).toBe(id);
    expect(await json(post(pc.token, `/api/devices/relay/work/${id}/fail`, { error: "Creator Toolset stopped while it ran this step" }))).toEqual({ ok: true });
    expect(row(e, "v1")).toMatchObject({ state: "queued", attempts: 1, error: "Creator Toolset stopped while it ran this step" });
    settle();
  });
});

describe.skipIf(rootReplaced)("the server's own loop", () => {
  it("takes a step no computer of the asker can take, and leaves one to a computer that is online", async () => {
    settle();
    const ran: string[] = [];
    const was = STEPS.preview!;
    STEPS.preview = async ({ variant }) => void ran.push(variant);
    try {
      const mac = pairDevice("loop", "Loop Mac");
      setDeviceWork(mac.device.id, { v: WORK_V, steps: [] }); // has a worker, but is not online
      file("loop", "ver_loop", { uploaded: true });
      const e = await newEdit("loop", ["ver_loop"]);
      queue("loop", e, "v1");
      expect(await tick()).toBe(true);
      expect(ran).toEqual(["v1"]);
      settle(); // the file step it queued next
      touchDevice(mac.device.id);
      queue("loop", e, "v2");
      expect(await tick()).toBe(false);
      expect(row(e, "v2").state).toBe("queued");
      // a step that reads no video stays the server's
      queue("loop", e, "v2", "file");
      const was2 = STEPS.file!;
      STEPS.file = async () => void ran.push("file");
      try {
        expect(await tick()).toBe(true);
        expect(ran).toEqual(["v1", "file"]);
      } finally {
        STEPS.file = was2;
      }
    } finally {
      STEPS.preview = was;
      settle();
    }
  });
});
