import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// the studio suite runs hosted (CT_MODE=hosted), where a server does video work only by a plug-in's grant (serverWorks):
// this file's server is its own, so the mode is cleared here and put back after
const hostedWas = process.env.CT_MODE;
delete process.env.CT_MODE;
import { WORK_V } from "../../contracts/work";
import type { JobRow } from "../library/jobs";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "server-work-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "server-work-test-secret";
// the studio run sets CT_MODE=hosted for every file; each test here sets the mode it needs, so this file starts with none
const modeWas = { CT_MODE: process.env.CT_MODE, CT_LOCAL: process.env.CT_LOCAL };
delete process.env.CT_MODE;
delete process.env.CT_LOCAL;

// every ffmpeg this server starts asks for its command first: counted here, and none really runs
const ffmpegRuns = vi.hoisted(() => ({ n: 0 }));
vi.mock("../ffmpeg-runtime", () => ({ ffmpegCommand: () => (ffmpegRuns.n++, "/nonexistent/ffmpeg") }));
// the package itself is item 4A's: here only which step goes where
vi.mock("./package", () => ({
  buildPackage: async (job: JobRow) => ({ v: 1, job: { id: job.id, kind: job.kind, editId: "", variant: "", actor: job.actor, workspaceId: "" }, edit: {}, own: [], rows: {}, files: [], caches: {}, ai: { editor: null, analyzer: null } }),
  ownFile: () => null,
}));

const sw = await import("./server-work");
const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { definePlugin, mountPlugins, pluginReplaces } = await import("../lib/plugin");
const rootReplaced = pluginReplaces("/api/editor");
const { libraryDb, blobs } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { devicesSaved, pairDevice, touchDevice } = await import("../lib/devices");
const { waitLine } = await import("../editor/reach");
const { STEPS, tick } = await import("../editor/worker");
const { measurable } = await import("../editor/media");
const { ffmpeg } = await import("../library/media/run");
const library = await import("../library/worker");
const { CLAIM_POLL } = await import("./routes");

CLAIM_POLL.holdMs = 0;

const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const post = (token: string, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = (token: string) => json<{ pkg: { job: { id: number } } | null }>(post(token, "/api/devices/relay/work/claim", { v: WORK_V, steps: [] }));
const BIG = { os: "linux", cpus: 32, memGb: 64, freeGb: 48, load: 0.05 };
const WAITS = "Waits for one of your computers. Open Creator Toolset on your Mac";

const cookies: Record<string, string> = {};
/** The name members see: the first admin's ("'s server"), as the route computes it. */
async function firstAdminServer(): Promise<string> {
  const first = (await import("../users")).listUsers().filter((x) => x.role === "admin").sort((a, b) => a.createdAt - b.createdAt)[0]!;
  return `${first.displayName || first.username}'s server`;
}
async function login(user: string, role: "user" | "admin" = "user") {
  setOff(createUser(user, "password1", { role }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: "password1" }) });
  cookies[user] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const as = (user: string, url: string, body?: unknown) =>
  app.request(url, body === undefined ? { headers: { cookie: cookies[user]! } } : { method: "PUT", headers: { cookie: cookies[user]!, "content-type": "application/json" }, body: JSON.stringify(body) });

/** A library of `user`'s (in workspace `ws`) with one uploaded file and its proxy, both on this server's disk. */
async function file(user: string, id: string, ws?: string) {
  libraryDb().exec(`
    INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_${id}', '${user}', 'L', 'local', '${ws ? JSON.stringify({ projectId: ws }) : "{}"}', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_${id}', 'lib_${id}', 'video', '${id}', '${user}', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe) VALUES
      ('${id}', 'ast_${id}', 1, 'k_${id}', 1, 'x', 'ready', '${user}', 0, '{"duration":1,"acodec":"aac","vcodec":"h264"}');
    INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('${id}', 'proxy', 'p_${id}', 1);
  `);
  for (const [key, text] of [[`k_${id}`, "the original"], [`p_${id}`, "the proxy"]] as const) {
    const f = path.join(dir, `${key}.mp4`);
    writeFileSync(f, text);
    await blobs.put(key, f);
  }
}
/** A workspace (Workshop project) of `owner`'s. */
function workspace(id: string, owner: string, extra: Record<string, unknown> = {}) {
  mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner, name: id, audience: "", voice: "", cta: "", notes: "", createdAt: 1, updatedAt: 1, ...extra }));
}
async function newEdit(user: string, sources: string[], ws?: string): Promise<string> {
  const id = (await json<{ id: string }>(app.request("/api/editor", { method: "POST", headers: { cookie: cookies[user]!, "content-type": "application/json" }, body: JSON.stringify({ name: "Cut", sources }) }))).id;
  libraryDb().exec("DELETE FROM edit_jobs"); // whatever creating it queued: each test queues its own steps
  if (ws) {
    const f = path.join(dir, "editor", id, "edit.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), projectId: ws }));
  }
  return id;
}
const queue = (user: string, editId: string, variant: string) => enqueueJob(libraryDb(), user, `${editId}:${variant}`, "preview", user, false, "edit_jobs");
const row = (editId: string, variant: string) => libraryDb().prepare("SELECT * FROM edit_jobs WHERE version_id = ? AND kind = 'preview'").get(`${editId}:${variant}`) as unknown as JobRow;
const settle = () => libraryDb().exec("UPDATE edit_jobs SET state = 'done', device = NULL WHERE state IN ('queued', 'running')");
const weight = (user: string, w: number) => {
  mkdirSync(path.join(dir, "balance"), { recursive: true });
  writeFileSync(path.join(dir, "balance", `${user}.json`), JSON.stringify({ on: true, weights: { server: w } }));
};

/** Runs the server's loop once with a preview step that reads its first source the way analysis does, through ffmpeg. */
async function serverTick(): Promise<{ took: boolean; read: string[] }> {
  const read: string[] = [];
  const was = STEPS.preview!;
  STEPS.preview = async ({ edit }) => {
    const f = await measurable(edit.sources[0]!, `k_${edit.sources[0]}`);
    read.push(readFileSync(f, "utf8"));
    await ffmpeg(["-i", f, "-f", "null", "-"]).catch(() => {});
  };
  try {
    return { took: await tick(), read };
  } finally {
    STEPS.preview = was;
  }
}

afterAll(async () => {
  await devicesSaved();
  if (modeWas.CT_LOCAL !== undefined) process.env.CT_LOCAL = modeWas.CT_LOCAL;
  if (hostedWas !== undefined) process.env.CT_MODE = hostedWas;
  else delete process.env.CT_MODE;
  rmSync(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("no file is off; the first start writes it off on every server, saying so where it was on", () => {
    rmSync(path.join(dir, "server-work.json"), { force: true }); // vitest.server-work.ts starts every test file with it on
    expect(sw.readServerWork()).toBeNull();
    expect(sw.serverWorks(null, "anyone")).toBe(false); // no file: off
    sw.settleServerWork();
    expect(sw.readServerWork()).toEqual({ on: false, v: 2 }); // a new server: nothing to say
    rmSync(path.join(dir, "server-work.json"));
    createUser("early", "password1", { role: "admin" });
    sw.settleServerWork();
    expect(sw.readServerWork()).toEqual({ on: false, v: 2, offByUpdate: true }); // in use, no file: it was on
    // a file from before this version that was on goes off, its workspace list kept
    writeFileSync(path.join(dir, "server-work.json"), JSON.stringify({ on: true, projectIds: ["ws-a"] }));
    sw.settleServerWork();
    expect(sw.readServerWork()).toEqual({ on: false, projectIds: ["ws-a"], v: 2, offByUpdate: true });
    // written once: a later start leaves the admin's choice alone
    sw.writeServerWork({ on: true });
    sw.settleServerWork();
    expect(sw.readServerWork()).toEqual({ on: true, v: 2 });
  });

  it("This Mac has no switch and always works", () => {
    sw.writeServerWork({ on: false });
    process.env.CT_LOCAL = "1";
    try {
      expect(sw.serverWorks("ws-any", "early")).toBe(true);
    } finally {
      delete process.env.CT_LOCAL;
    }
    sw.writeServerWork({ on: true });
  });

  it("only the workspaces the admin picks: an owner's old per-workspace choice is no longer read", () => {
    workspace("ws-aaa", "early");
    workspace("ws-bbb", "early", { serverWork: false });
    sw.writeServerWork({ on: true, projectIds: ["ws-aaa", "ws-bbb"] });
    expect(sw.serverWorks("ws-aaa", "early")).toBe(true);
    expect(sw.serverWorks("ws-bbb", "early")).toBe(true);
    expect(sw.serverWorks("ws-ccc", "early")).toBe(false);
    expect(sw.serverWorks(null, "early")).toBe(false);
    sw.writeServerWork({ on: true });
  });

  it("an owner's 'Your computers' choice becomes the list, once; a workspace made later starts off", () => {
    workspace("ws-mig-on", "early");
    workspace("ws-mig-own", "early", { serverWork: false });
    sw.writeServerWork({ on: true, offByUpdate: true });
    sw.migrateOwnerChoices();
    const once = sw.readServerWork();
    expect(once).toMatchObject({ on: true, offByUpdate: true });
    expect(once?.projectIds).toContain("ws-mig-on");
    expect(once?.projectIds).not.toContain("ws-mig-own");
    sw.migrateOwnerChoices();
    expect(sw.readServerWork()).toEqual(once);
    workspace("ws-mig-new", "early");
    expect(sw.serverWorks("ws-mig-on", "early")).toBe(true);
    expect(sw.serverWorks("ws-mig-own", "early")).toBe(false);
    expect(sw.serverWorks("ws-mig-new", "early")).toBe(false);
    sw.writeServerWork({ on: true });
  });
});

describe.skipIf(rootReplaced)("the AI Editor's video steps", () => {
  let mac: ReturnType<typeof pairDevice>;
  beforeAll(async () => {
    for (const u of ["maker", "solo", "far"]) await login(u);
    await login("boss", "admin");
    mac = pairDevice("maker", "Maker Mac");
    await post(mac.token, "/api/devices/relay/report", { drivers: [], homes: [], machine: BIG });
    expect(await claim(mac.token)).toMatchObject({ pkg: null }); // its worker said it is there
    await file("maker", "ver_m");
    await file("solo", "ver_s");
    await file("far", "ver_f");
  });

  it("switched on, with no computer online, the server runs the step from the proxy (PRD test 4)", async () => {
    sw.writeServerWork({ on: true });
    const e = await newEdit("solo", ["ver_s"]);
    queue("solo", e, "v1");
    ffmpegRuns.n = 0;
    const { took, read } = await serverTick();
    expect(took).toBe(true);
    expect(read).toEqual(["the proxy"]);
    expect(ffmpegRuns.n).toBe(1);
    settle();
  });

  it("switched off: no decode on the server; the step waits with its line, and a computer takes it", async () => {
    sw.writeServerWork({ on: false });
    const solo = pairDevice("solo", "Solo Mac"); // paired, not online yet
    const e = await newEdit("solo", ["ver_s"]);
    queue("solo", e, "v1");
    ffmpegRuns.n = 0;
    expect((await serverTick()).took).toBe(false);
    expect(ffmpegRuns.n).toBe(0);
    expect(row(e, "v1").state).toBe("queued");
    expect(waitLine("solo", row(e, "v1"))).toBe(WAITS);
    expect((await claim(solo.token)).pkg?.job.id).toBe(row(e, "v1").id);
    expect(ffmpegRuns.n).toBe(0);
    settle();
    sw.writeServerWork({ on: true });
  });

  it("Load balancing: on, the server takes a step no computer can read and no computer gets a copy of it (PRD 5.5); Off hands it to the computer's Downloads", async () => {
    const e = await newEdit("maker", ["ver_m"]);
    queue("maker", e, "v1");
    // Normal: the online computer has none of the files, and with the server on at weight > 0 it gets no server copy
    touchDevice(mac.device.id);
    expect((await serverTick()).took).toBe(true);
    settle();
    // Prefer: the computer is not handed it while the server is free, and the server runs it
    const p = await newEdit("maker", ["ver_m"]);
    queue("maker", p, "v1");
    weight("maker", 100);
    expect((await claim(mac.token)).pkg).toBeNull();
    expect((await serverTick()).took).toBe(true);
    settle();
    // the server busy with another step: still no copy for the computer, so the step waits for the server
    const busy = await newEdit("maker", ["ver_m"]);
    queue("maker", busy, "v1");
    libraryDb().exec(`UPDATE edit_jobs SET state = 'running', device = NULL, lease_until = ${Date.now() + 60_000} WHERE state = 'queued'`);
    queue("maker", e, "v2");
    expect((await claim(mac.token)).pkg).toBeNull();
    settle();
    rmSync(path.join(dir, "balance", "maker.json"));
    // Off: the server never takes it; the online computer takes it, since its Downloads (default: needed) allows a copy
    weight("maker", 0);
    const o = await newEdit("maker", ["ver_m"]);
    queue("maker", o, "v1");
    ffmpegRuns.n = 0;
    expect((await serverTick()).took).toBe(false);
    expect(ffmpegRuns.n).toBe(0);
    expect((await claim(mac.token)).pkg?.job.id).toBe(row(o, "v1").id);
    settle();
    rmSync(path.join(dir, "balance", "maker.json"));
    // Off, for someone with no computer online: the step waits for one
    weight("far", 0);
    const off = await newEdit("far", ["ver_f"]);
    queue("far", off, "v1");
    ffmpegRuns.n = 0;
    expect((await serverTick()).took).toBe(false);
    expect(ffmpegRuns.n).toBe(0);
    expect(waitLine("far", row(off, "v1"))).toBe(WAITS);
    settle();
    rmSync(path.join(dir, "balance", "far.json"));
  });

  it("a member sees the server's name and whether the current workspace renders on it", async () => {
    workspace("ws-on", "far");
    workspace("ws-off", "far");
    sw.writeServerWork({ on: true, projectIds: ["ws-on"] });
    const view = (ws: string) => json(app.request("/api/work/server-work", { headers: { cookie: cookies.far!, "x-ct-workspace": ws } }));
    expect(await view("ws-on")).toMatchObject({ serverName: await firstAdminServer(), workspace: { id: "ws-on", rendering: true } });
    expect(await view("ws-off")).toMatchObject({ workspace: { id: "ws-off", rendering: false } });
    sw.writeServerWork({ on: true });
  });

  // replaced (CEO 11-19): a hosted server with no plug-in naming it is its first admin's ("Creator Toolset Cloud" comes
  // from the plug-in that names it, the last describe below); This Mac still has none
  it("the server's name: a Server is its first admin's when no plug-in names it, none on This Mac", async () => {
    process.env.CT_MODE = "hosted";
    try {
      expect(await json(app.request("/api/work/server-work", { headers: { cookie: cookies.far! } }))).toMatchObject({ kind: "server", serverName: await firstAdminServer() });
    } finally {
      delete process.env.CT_MODE;
    }
    process.env.CT_LOCAL = "1";
    try {
      const v = await json(app.request("/api/work/server-work", { headers: { cookie: cookies.far! } }));
      expect(v.kind).toBe("mac");
      expect(v.serverName).toBeUndefined();
    } finally {
      delete process.env.CT_LOCAL;
    }
  });

  it("Settings: the admin's switch, and the person's server row", async () => {
    workspace("ws-boss", "boss");
    const view = await json(as("boss", "/api/work/server-work"));
    expect(view).toMatchObject({ kind: "server", place: { allowed: true, weight: 50 }, admin: { on: true, all: true } });
    expect((await as("solo", "/api/work/server-work", { on: false })).status).toBe(403);
    expect(await json(as("boss", "/api/work/server-work", { only: ["ws-boss"] }))).toMatchObject({ on: true, all: false });
    // solo's workspaces are not on the list: no server row for them
    expect(await json(as("solo", "/api/work/server-work"))).toEqual({ kind: "server", place: { allowed: false, weight: 50 }, serverName: await firstAdminServer() });
    expect((await as("boss", "/api/work/server-work", { only: ["nope"] })).status).toBe(400);
    await as("boss", "/api/work/server-work", { all: true });
    // the server's preference saves with the computers'
    expect(await json(as("solo", "/api/devices/balance", { weights: { server: 100 } }))).toMatchObject({ weights: { server: 100 } });
    expect(sw.serverWeight("solo")).toBe(100);
  });
});

describe("the Media Library's work", () => {
  beforeAll(async () => {
    if (!cookies.lib) await login("lib");
    await file("lib", "ver_l");
  });
  const job = (kind: string) => libraryDb().prepare("SELECT * FROM jobs WHERE version_id = 'ver_l' AND kind = ?").get(kind) as unknown as JobRow;

  it("switched off, nothing that decodes runs here: each waits with its line", async () => {
    sw.writeServerWork({ on: false });
    enqueueJob(libraryDb(), "lib_ver_l", "ver_l", "wave", "lib");
    enqueueJob(libraryDb(), "lib_ver_l", "ver_l", "transcribe", "lib");
    ffmpegRuns.n = 0;
    expect(await library.tick(Date.now(), ["wave", "transcribe"])).toBe(false);
    expect(ffmpegRuns.n).toBe(0);
    expect(job("wave")).toMatchObject({ state: "queued", error: library.WAITS_FOR_COMPUTER });
    // a transcript is computer work too since 6B (the computer cuts the sound from its own copy)
    expect(job("transcribe")).toMatchObject({ state: "queued", error: library.WAITS_FOR_COMPUTER });
  });

  it("switched off: a look goes to the Mac the file came from, a description is written again from its words, and what waits is no time left", async () => {
    const db = libraryDb();
    const { progress } = await import("../library/estimate");
    const { macLookJob } = await import("../library/mac-look");
    const { MAC_WAITS } = await import("../library/shots");
    const mac = pairDevice("lib", "Lib Mac"); // paired, not online
    db.prepare("UPDATE asset_versions SET from_path = '/Volumes/Card/clip.mov', from_device = ? WHERE id = 'ver_l'").run(mac.device.id);
    enqueueJob(db, "lib_ver_l", "ver_l", "look", "lib");
    enqueueJob(db, "lib_ver_l", "ver_l", "describe", "lib");
    // the look is not left for video work this server doesn't do: it parks for that Mac (or for an AI first)
    expect(await library.tick(Date.now(), ["look"])).toBe(true);
    expect(job("look").state).toBe("needs_key");
    // never described: a description needs the picture, so it waits for a computer to cut its stills (library-package.ts)
    expect(await library.tick(Date.now(), ["describe"])).toBe(false);
    expect(job("describe")).toMatchObject({ state: "queued", error: library.WAITS_FOR_COMPUTER });
    // waiting, said as such: no "Preparing … left" for work nothing here will run
    const p = await progress("lib_ver_l", "lib");
    expect(p.left).toBe(0);
    expect(p.waiting).toContainEqual(expect.objectContaining({ step: "describe", count: 1, away: true }));
    expect(p.waiting).toContainEqual(expect.objectContaining({ step: "files", away: true }));
    // described before (Describe again, a workspace's new words): written from its words, no picture read here
    db.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES ('ver_l', 'ai', 'A boss fight', 'x', 1)").run();
    // (a description waits for its transcript: that one is through here)
    db.exec("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_l' AND kind = 'transcribe'");
    expect(await library.tick(Date.now(), ["describe"])).toBe(true);
    expect(job("describe").error).not.toBe(library.WAITS_FOR_SERVER);
    // that Mac is handed the look with the path the file was sent from
    db.prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE version_id = 'ver_l' AND kind = 'look'").run(MAC_WAITS);
    expect(macLookJob.claim({ ...mac.device, owner: "lib" })?.options?.path).toBe("/Volumes/Card/clip.mov");
    db.exec("DELETE FROM jobs WHERE version_id = 'ver_l' AND kind IN ('look', 'describe'); DELETE FROM descriptions WHERE version_id = 'ver_l'");
    db.exec("UPDATE asset_versions SET from_path = NULL, from_device = NULL WHERE id = 'ver_l'");
  });

  it("switched on, the server makes them", async () => {
    sw.writeServerWork({ on: true });
    ffmpegRuns.n = 0;
    expect(await library.tick(Date.now(), ["wave"])).toBe(true);
    expect(ffmpegRuns.n).toBe(1);
  });
});

// last: it replaces the loaded plug-ins
describe("Creator Toolset Cloud", () => {
  it("does no video work, but for the accounts a plug-in grants it", () => {
    process.env.CT_SERVER = "cloud";
    try {
      expect(sw.serverWorks(null, "early")).toBe(false);
      mountPlugins(new Hono(), [definePlugin({ id: "grants", serverWork: ({ account }) => (account === "granted" ? true : undefined) })]);
      expect(sw.serverWorks(null, "granted")).toBe(true);
      expect(sw.serverWorks(null, "early")).toBe(false);
    } finally {
      delete process.env.CT_SERVER;
    }
  });

  // replaced (CEO 11-19): "Creator Toolset Cloud" is the name the hosted plug-in gives the server (ServerPlugin.serverName)
  it("is named by the plug-in that names it, and This Mac still has no name", async () => {
    // the helper the route answers with: an HTTP call here would go through the replaced plug-ins' sign-in
    const { serverNameOf } = await import("./server-work-routes");
    mountPlugins(new Hono(), [definePlugin({ id: "cloud-name", serverName: "Creator Toolset Cloud" })]);
    expect(serverNameOf("cloud")).toBe("Creator Toolset Cloud");
    expect(serverNameOf("server")).toBe("Creator Toolset Cloud");
    expect(serverNameOf("mac")).toBeUndefined();
  });
});

describe("mayRunHere: where processing runs", () => {
  it("waits with no computer and the server's work off; the server with it on; a computer of theirs first", async () => {
    const { mayRunHere } = await import("./place");
    const q = (open: boolean, computer: boolean, first = false) => ({ reads: true, open: () => open, first: () => first, computer: () => computer });
    expect(mayRunHere(q(false, false))).toBe("wait");
    expect(mayRunHere(q(true, false))).toBe("server");
    expect(mayRunHere(q(true, true))).toBe("computer");
    expect(mayRunHere(q(false, true))).toBe("computer");
    expect(mayRunHere(q(true, true, true))).toBe("server"); // Prefer for this server
    expect(mayRunHere({ ...q(false, false), reads: false })).toBe("server"); // reads no video or sound
  });
});
