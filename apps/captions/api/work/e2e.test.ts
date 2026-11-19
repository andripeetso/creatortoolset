import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Edit } from "../../contracts/editor";
import { WORK_V } from "../../contracts/work";

/**
 * Where work runs, end to end (PRD section 7, as far as phase 4 reaches): the server's real app on a local port, and the
 * computers' real worker (work/computer.ts) claiming from it over HTTP with paired device tokens. Each computer is its
 * own data folder and its own module copy, as a second process would be. Nothing of the steps is mocked: tiny clips made
 * with ffmpeg, the AI a local stand-in for the API answering the server (the computers' AI calls go through it).
 *
 * The team: ana owns the footage and has two computers (Studio Mac has the originals on its disk, Ana Laptop has none);
 * bo is given ana's workspace and has one computer, without the files.
 */

// which side runs ffmpeg: a computer's worker runs in this store; the server (its routes and loop) outside any
const ff = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<string>(), wrapper: "" };
});
// the server's ffmpeg goes through a wrapper that logs each run (ffmpegCommand is read at every run)
vi.mock("../ffmpeg-runtime", async (orig) => {
  const real = await orig<typeof import("../ffmpeg-runtime")>();
  return { ...real, ffmpegCommand: () => (ff.wrapper && ff.als.getStore() !== "computer" ? ff.wrapper : real.ffmpegCommand()) };
});
// no face model download in a test
vi.mock("../editor/eyeline", () => ({ eyelineOf: vi.fn(async () => null) }));

// the AI: a text call is the plan (or the fix round's plan), a call with pictures the look at a cut
const answers = { plan: "", fix: "", lookFails: 0 };
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let text = answers.plan;
    if (body.includes('"type":"image"')) text = JSON.stringify(answers.lookFails-- > 0 ? { fails: [{ n: 1, why: "The first shot is soft" }] } : { fails: [] });
    else if (body.includes("Replace those shots and nothing else")) text = answers.fix;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const S = mkdtempSync(path.join(scratch, "e2e-server-"));
process.env.DATA_DIR = S;
process.env.APP_SECRET = "e2e-test-secret";

const FIRST = "cccccccc-0000-4000-8000-0000000000e2";
mkdirSync(path.join(S, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(S, "workshop", "projects", `${FIRST}.json`), JSON.stringify({ id: FIRST, owner: "ana", name: "Tiny Acrobatics", notes: "Keep it playful", createdAt: 1, updatedAt: 1 }));
const member = (username: string, role: string, workspaces?: string[]) => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(S, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [member("ana", "owner"), member("bo", "member", [FIRST])] }], invites: [], spend: {} }),
);

const srv = {
  app: (await import("../boot")).default,
  ...(await import("../users")),
  ...(await import("../my-keys")),
  ...(await import("../library/db")),
  ...(await import("../library/jobs")),
  ...(await import("../library/transcribe")),
  ...(await import("../lib/devices")),
  ...(await import("../library/sources")),
  ...(await import("./package")),
  ...(await import("../editor/index")),
  ...(await import("../editor/store")),
  ...(await import("../editor/worker")),
  ...(await import("./place")),
  ...(await import("./routes")),
};
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");

/** A computer: its own data folder and module copy, loaded as a second process would load them. */
async function computerAt(name: string) {
  const dir = mkdtempSync(path.join(scratch, `e2e-${name}-`));
  process.env.DATA_DIR = dir;
  vi.resetModules();
  const mod = await import("./computer");
  process.env.DATA_DIR = S;
  return { name, dir, mod, token: "", id: "" };
}
const boMac = await computerAt("bo-mac");
const studio = await computerAt("studio-mac");
const laptop = await computerAt("ana-laptop");
type Computer = typeof boMac;

const FILES = [
  { v: "ver_a", title: "Tiny Acrobatics arena", src: "testsrc" },
  { v: "ver_b", title: "Tiny Acrobatics town", src: "testsrc2" },
  { v: "ver_c", title: "Tiny Acrobatics bars", src: "smptebars" },
];
const bytes = { original: {} as Record<string, number>, proxy: {} as Record<string, number> };

// ---- what crossed the wire, and what the server ran itself ----
interface Hit { who: string; method: string; path: string; query: string; status: number; bytes: number }
const hits: Hit[] = [];
const tokens = new Map<string, string>();
const ranOnServer: { version: string; kind: string }[] = [];
const ffLog = path.join(S, "ffmpeg-runs.log");

/** The server's ffmpeg runs since `from` that decode video or sound: an input that is a file and not a picture. */
function serverDecodes(from = 0): string[] {
  const runs = existsSync(ffLog) ? readFileSync(ffLog, "utf8").split("\n").filter(Boolean).slice(from) : [];
  return runs.filter((line) => {
    const args = line.split(" ");
    return args.some((a, i) => args[i - 1] === "-i" && a.startsWith("/") && !/\.(png|jpe?g|bmp)$/i.test(a));
  });
}
const ffRuns = () => (existsSync(ffLog) ? readFileSync(ffLog, "utf8").split("\n").filter(Boolean).length : 0);

/** Proxy bytes the footage route sent to `who` since hit `from`, by version. */
function footage(who: string, from = 0): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits.slice(from)) {
    const m = h.path.match(/\/editor\/job\/\d+\/footage\/([^/]+)$/);
    if (m && h.who === who) out[m[1]!] = (out[m[1]!] ?? 0) + h.bytes;
  }
  return out;
}
const jobRow = (id: number) => srv.libraryDb().prepare("SELECT * FROM edit_jobs WHERE id = ?").get(id) as { version_id: string; kind: string; state: string; error: string | null } | undefined;
/** A point in the traffic and in the server's own runs, to look from. */
const mark = () => ({ hits: hits.length, server: ranOnServer.length });
/** Where each of this edit's steps of `kind` ran since `from`: the computer that sent its result, or "server". */
function ranBy(editId: string, kind: string, from = { hits: 0, server: 0 }): string[] {
  const on = hits.slice(from.hits).flatMap((h) => {
    const m = h.method === "POST" && h.path.match(/\/work\/(\d+)\/done$/);
    const r = m && jobRow(Number(m[1]));
    return r && r.kind === kind && r.version_id.startsWith(`${editId}:`) ? [h.who] : [];
  });
  return [...on, ...ranOnServer.slice(from.server).filter((r) => r.kind === kind && r.version.startsWith(`${editId}:`)).map(() => "server")];
}

// ---- hooks the computers' traffic passes through ----
const stopping = new Set<string>();
const hooks: { put?: (who: string, jobId: number) => Promise<void>; done?: (who: string, jobId: number) => Promise<void>; old?: Set<string> } = {};
const fetchFor = (who: string) => async (url: string, init: RequestInit = {}): Promise<Response> => {
  const p = new URL(url).pathname;
  const m = p.match(/\/work\/(\d+)\/(file|done)$/);
  if (m?.[2] === "file") await hooks.put?.(who, Number(m[1]));
  if (m?.[2] === "done") await hooks.done?.(who, Number(m[1]));
  // an older app: the same worker, its claim naming an older package version
  // the test is done with this computer: its worker ends (the answer an app gets when it must update ends it too)
  if (p.endsWith("/work/claim") && stopping.has(who)) return Response.json({ pkg: null, update: true });
  if (p.endsWith("/work/claim") && hooks.old?.has(who)) init = { ...init, body: JSON.stringify({ ...JSON.parse(String(init.body)), v: 0 }) };
  return fetch(url, init);
};

let base = "";
let server: ReturnType<typeof serve>;
/** Runs computer `c`'s worker, as the app keeps it running, until `finish` (or the server says to update: "update"). */
const work = (c: Computer) =>
  ff.als.run("computer", () => c.mod.startComputerWorker({ server: base, token: c.token, fetch: fetchFor(c.name), beatMs: 50, downloadBeatMs: 50, retryMs: 50 }));
/** Ends these computers' workers after their running step, once each asks for its next. */
async function finish(cs: Computer[], runs: Promise<unknown>[]) {
  for (const c of cs) stopping.add(c.name);
  await Promise.all(runs);
  for (const c of cs) stopping.delete(c.name);
}

/** Until each computer's worker has claimed with this app's package version (it is online, and takes steps). */
const ready = (...cs: Computer[]) => until("the computers online", () => cs.every((c) => srv.isOnline(c.id) && srv.deviceOf(c.id)?.work?.v === WORK_V));

/** The server's own loop, while `on`. In phase 4 it still takes a video step no computer online can take: the tests
 *  start it once the computers have claimed. */
const loop = { on: false, done: Promise.resolve() };
function startLoop() {
  loop.on = true;
  loop.done = (async () => {
    while (loop.on) if (!(await srv.tick())) await new Promise((r) => setTimeout(r, 20));
  })();
}
async function stopLoop() {
  loop.on = false;
  await loop.done;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const active = (editId: string) => srv.libraryDb().prepare("SELECT kind, version_id, state, error, device, attempts FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").all(editId);
async function until(what: string, ok: () => boolean, editId?: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      const jobs = editId ? srv.libraryDb().prepare("SELECT id, kind, version_id, state, error, device, attempts FROM edit_jobs WHERE edit_id = ?").all(editId) : [];
      throw new Error(`Timed out: ${what}\n${JSON.stringify(jobs, null, 1)}`);
    }
    await sleep(25);
  }
}
const review = (editId: string) => (srv.readStep(editId, "review") ?? {}) as Record<string, { assetId: string; n: number; by?: string }>;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const cookies: Record<string, string> = {};
const call = (user: string, method: string, url: string, body?: unknown) =>
  srv.app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json", "x-ct-workspace": FIRST }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const lineOf = async (user: string, editId: string, kind: string) => (await json<Edit & { jobs: { kind: string; state: string; line?: string }[] }>(call(user, "GET", `/api/editor/${editId}`))).jobs.find((j) => j.kind === kind && j.state === "queued")?.line;

/** A planned edit made by `user` from ana's footage, started: its server steps run up to its first computer step, which waits. */
async function newEdit(user: string, versions: number): Promise<string> {
  const { id } = await json<{ id: string }>(call(user, "POST", "/api/editor", { name: `${user}'s hard edit`, sources: ["ver_a", "ver_b"], projectId: FIRST, plan: true, brief: "A hard edit, 3 seconds", versions }));
  expect(id).toBeTruthy();
  expect((await call(user, "POST", `/api/editor/${id}/run`, {})).status).toBe(200);
  // the analyze of a planned edit reads no footage: the server's
  while (!active(id).some((j) => (j as { kind: string }).kind === "script")) expect(await srv.tick()).toBe(true);
  return id;
}

beforeAll(async () => {
  for (const u of ["ana", "bo"]) {
    srv.setOff(srv.createUser(u, "password1", { role: "user" }), []);
    const res = await srv.app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: "password1" }) });
    cookies[u] = res.headers.get("set-cookie")!.split(";")[0]!;
    srv.saveMyKey(u, "ANTHROPIC_API_KEY", "sk-ant-test");
  }
  for (const [c, owner, name] of [[boMac, "bo", "Bo Mac"], [studio, "ana", "Studio Mac"], [laptop, "ana", "Ana Laptop"]] as const) {
    const p = srv.pairDevice(owner, name);
    Object.assign(c, { token: p.token, id: p.device.id });
    tokens.set(`Bearer ${p.token}`, c.name);
  }

  // ana's footage: uploaded originals with their proxies; the Studio Mac has the originals on its disk (the index's path)
  const db = srv.libraryDb();
  // search by picture off: its work (work/pictures.ts) would fetch the real model here
  db.exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_t', 't', 'Footage', 'local', '{"projectId":"${FIRST}","pictures":false}', 0)`);
  const gen = path.join(S, "gen");
  mkdirSync(gen);
  mkdirSync(path.join(studio.dir, "Footage"));
  const run = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  for (const f of FILES) {
    const original = path.join(gen, `${f.v}.mp4`);
    const proxy = path.join(gen, `${f.v}.proxy.mp4`);
    run(["-f", "lavfi", "-i", `${f.src}=duration=4:size=640x360:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-vf", "noise=alls=30:allf=t", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", original]);
    run(["-i", original, "-vf", "scale=320:180", "-c:v", "libx264", "-crf", "34", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", proxy]);
    bytes.original[f.v] = statSync(original).size;
    bytes.proxy[f.v] = statSync(proxy).size;
    const onStudio = path.join(studio.dir, "Footage", `${f.title}.mp4`);
    copyFileSync(original, onStudio);
    const probe = JSON.stringify({ duration: 4, width: 640, height: 360, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" });
    db.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_t', 'video', ?, 'ana', 0)").run(`a_${f.v}`, f.title);
    db.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, mac_path, mac_device) VALUES (?, ?, 1, ?, ?, ?, ?, 'ready', 'ana', 0, ?, ?)").run(
      f.v, `a_${f.v}`, `libraries/lib_t/v/${f.v}/source`, bytes.original[f.v]!, `s_${f.v}`, probe, onStudio, studio.id,
    );
    await srv.blobs.put(`libraries/lib_t/v/${f.v}/source`, original);
    await srv.blobs.put(`libraries/lib_t/v/${f.v}/proxy`, proxy);
    db.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, ?)").run(f.v, `libraries/lib_t/v/${f.v}/proxy`, bytes.proxy[f.v]!);
    const words = [
      { w: "Tiny", s: 0.2, e: 0.5 },
      { w: "acrobatics", s: 0.55, e: 1.1 },
      { w: "jump.", s: 1.2, e: 1.6 },
      { w: "Again", s: 2.6, e: 3 },
    ];
    srv.saveTranscript(db, f.v, "test", "en", [{ start: 0.2, end: 3, text: words.map((w) => w.w).join(" ") }], words);
    const stamp = await srv.shotLog.stamp(f.v);
    const q = db.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at) VALUES (?, ?, ?, ?, 0.5, 3, 1, ?, ?, ?, 'ai', ?, 0)");
    for (let k = 0; k < 2; k++) q.run(f.v, k, k * 2, k * 2 + 2, JSON.stringify(["jump"]), `${f.title}, part ${k}`, `${f.v}${k}`.padEnd(16, "0"), stamp);
  }
  srv.shotLog.first = () => {};
  srv.shotLog.redo = () => false;
  // the originals differ from the proxies by far: a byte count tells which was sent
  for (const f of FILES) expect(bytes.original[f.v]!).toBeGreaterThan(2 * bytes.proxy[f.v]!);

  // from here, every ffmpeg run on the server is logged
  const real = execFileSync("sh", ["-c", "command -v ffmpeg"]).toString().trim();
  ff.wrapper = path.join(S, "ffmpeg-logged");
  writeFileSync(ff.wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ffLog}'\nexec '${real}' "$@"\n`);
  chmodSync(ff.wrapper, 0o755);
  // every step the server runs itself
  for (const [kind, step] of Object.entries(srv.STEPS)) srv.STEPS[kind] = async (ctx) => (ranOnServer.push({ version: ctx.job.version_id ?? "", kind }), step!(ctx));

  srv.CLAIM_POLL.holdMs = 200;
  srv.CLAIM_POLL.everyMs = 25;
  // the server on a port, counting what the footage route sends
  server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req, env) => {
      const res = await srv.app.fetch(req, env);
      const u = new URL(req.url);
      const hit: Hit = { who: tokens.get(req.headers.get("authorization") ?? "") ?? "person", method: req.method, path: u.pathname, query: u.search, status: res.status, bytes: 0 };
      hits.push(hit);
      if (!res.body || !u.pathname.includes("/footage/")) return res;
      const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, ctl) => void ((hit.bytes += chunk.byteLength), ctl.enqueue(chunk)) }));
      return new Response(counted, { status: res.status, headers: res.headers });
    },
  });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  for (const c of [boMac, studio, laptop]) stopping.add(c.name);
  loop.on = false;
  await loop.done;
  if (server) {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  api.close();
  await srv.devicesSaved();
  for (const d of [S, boMac.dir, studio.dir, laptop.dir]) rmSync(d, { recursive: true, force: true });
}, 30_000);

describe.skipIf(rootReplaced)("where work runs, end to end: the server on a port, the computers' workers claiming from it", () => {
  let bos = "";
  let anas = "";
  // A person's Load balancing weight for the server (PRD 4.7). The teammates' server is at 0, so their computers do the
  // video steps and fetch their own copies; above 0 the server takes every step a computer lacks the files for.
  const setBalance = (user: string, weights: Record<string, number>) => {
    mkdirSync(path.join(S, "balance"), { recursive: true });
    writeFileSync(path.join(S, "balance", `${user}.json`), JSON.stringify({ on: true, weights }));
  };
  beforeAll(() => {
    setBalance("bo", { server: 0 });
    setBalance("ana", { server: 0 });
  });

  it("no computer online: the step waits with the one line; with one online the server's loop leaves it and that computer takes it (PRD 3)", async () => {
    answers.plan = JSON.stringify({ plans: [{ kind: "hard edit", lead: "sources", shots: [{ src: "S1", in: 0, dur: 1 }, { src: "S2", in: 1, dur: 1 }, { src: "S1", in: 2.5, dur: 1 }] }] });
    bos = await newEdit("bo", 1);
    expect(await lineOf("bo", bos, "script")).toBe("Waits for one of your computers. Open Creator Toolset on your Mac");
    // the server's weight is 0 for bo: a computer that lacks the files takes the step only once it is online
    const worker = work(boMac);
    await until("Bo Mac online", () => srv.isOnline(boMac.id));
    const script = srv.libraryDb().prepare("SELECT * FROM edit_jobs WHERE edit_id = ? AND kind = 'script'").get(bos) as never;
    expect(srv.serverMayTake(script)).toBe(false);
    startLoop();
    await until("bo's edit filed in Review", () => !!review(bos).v1 && !active(bos).length, bos);
    await stopLoop();
    await finish([boMac], [worker]);
    expect(ranBy(bos, "script")).toEqual(["bo-mac"]);
    expect(ranOnServer.filter((r) => r.version.startsWith(bos) && r.kind === "script")).toEqual([]);
  }, 180_000);

  it("a teammate without the files: their computer downloads only the proxies the edit uses, runs its video steps, and the preview is in Review under their name (PRD 1)", async () => {
    // the video steps ran on bo's computer; the server ran only the steps that read no video or sound
    for (const kind of ["script", "preview", "critique"]) expect(ranBy(bos, kind)).toEqual(["bo-mac"]);
    expect(ranOnServer.filter((r) => r.version.startsWith(bos) && ["script", "preview", "critique"].includes(r.kind))).toEqual([]);
    expect(ranOnServer.some((r) => r.version.startsWith(bos) && r.kind === "draft")).toBe(true);
    // only the proxies of the edit's two clips, each once, never ver_c, never an original
    expect(footage("bo-mac")).toEqual({ ver_a: bytes.proxy.ver_a, ver_b: bytes.proxy.ver_b });
    expect(hits.filter((h) => h.path.includes("/footage/") && (h.query.includes("original") || h.who !== "bo-mac"))).toEqual([]);
    // each step ran once: none was handed out before what it reads was in place (the file step after Review has the preview)
    expect(srv.libraryDb().prepare("SELECT kind, attempts, error FROM edit_jobs WHERE edit_id = ? AND attempts != 1").all(bos)).toEqual([]);
    // filed in the workspace's Review under bo, and shown on the edit
    expect(review(bos).v1).toMatchObject({ by: "bo" });
    const e = await json<Edit>(call("bo", "GET", `/api/editor/${bos}`));
    expect(e.previews.v1).toBeTruthy();
    expect(e.createdBy).toBe("bo");
    const seen = await json<Edit>(call("ana", "GET", `/api/editor/${bos}`));
    expect(seen.previews.v1).toEqual(e.previews.v1);
    // the server decoded no video or sound for them
    expect(serverDecodes()).toEqual([]);
  });

  it("the cache emptied: the next job downloads what it needs again (PRD 6)", async () => {
    const again = async () => {
      const at = mark();
      const from = at.hits;
      const n = review(bos).v1!.n;
      expect((await call("bo", "POST", `/api/editor/${bos}/drafts/v1/review`, {})).status).toBe(200);
      const worker = work(boMac);
      await ready(boMac);
      startLoop();
      await until("filed again", () => review(bos).v1!.n > n && !active(bos).length, bos);
      await stopLoop();
      await finish([boMac], [worker]);
      expect(ranBy(bos, "preview", at)).toEqual(["bo-mac"]);
      return footage("bo-mac", from);
    };
    // the proxies are in its cache: nothing downloads
    expect(await again()).toEqual({});
    rmSync(path.join(boMac.dir, "proxies"), { recursive: true, force: true });
    // emptied: the preview downloads the proxies its draft plays, once more
    expect(await again()).toEqual({ ver_a: bytes.proxy.ver_a, ver_b: bytes.proxy.ver_b });
    expect(serverDecodes()).toEqual([]);
  }, 240_000);

  it("a teammate a library policy refuses one of the edit's clips gets no package and no footage for it", async () => {
    const at = mark();
    // a stand-in policy (a plug-in that shows members only blurred footage, say): bo may no longer see the town clip
    srv.registerLibrarySlot("test-refuse", { policies: [{ sourceId: "library", canSee: (v, a) => a.assetId !== "a_ver_b" || v.username !== "bo" }] });
    try {
      srv.enqueueJob(srv.libraryDb(), "t", `${bos}:v1`, "preview", "bo", true, "edit_jobs");
      const job = srv.libraryDb().prepare("SELECT id FROM edit_jobs WHERE edit_id = ? AND kind = 'preview' AND state = 'queued'").get(bos) as { id: number };
      // the server's loop is off: only the claim decides
      const worker = work(boMac);
      await until("the claim refused it", () => jobRow(job.id)?.state !== "queued");
      await sleep(300); // a few more claims: none hands it out
      await finish([boMac], [worker]);
      expect(jobRow(job.id)).toMatchObject({ state: "failed", error: "Some footage was deleted or cannot be read by this account" });
      expect(existsSync(srv.keptPath(job.id))).toBe(false);
      expect(hits.slice(at.hits).filter((h) => h.who === "bo-mac" && !h.path.endsWith("/work/claim"))).toEqual([]);
      expect(ranBy(bos, "preview", at)).toEqual([]);
    } finally {
      srv.resetLibrarySlots();
    }
  }, 60_000);

  it("an older app takes nothing and is told to update; the step says so (PRD 7)", async () => {
    answers.plan = JSON.stringify({
      plans: [
        { kind: "hard edit", lead: "sources", shots: [{ src: "S1", in: 0, dur: 1 }, { src: "S2", in: 1, dur: 1 }, { src: "S1", in: 2.5, dur: 1 }] },
        { kind: "hard edit", lead: "sources", shots: [{ src: "S2", in: 0, dur: 1 }, { src: "S1", in: 1, dur: 1 }, { src: "S2", in: 2, dur: 1 }] },
      ],
    });
    anas = await newEdit("ana", 2);
    hooks.old = new Set(["ana-laptop"]);
    try {
      expect(await work(laptop)).toBe("update");
    } finally {
      delete hooks.old;
    }
    expect(active(anas)).toMatchObject([{ kind: "script", state: "queued" }]);
    expect(hits.filter((h) => h.who === "ana-laptop").map((h) => h.path)).toEqual(["/api/devices/relay/work/claim"]);
    expect(await lineOf("ana", anas, "script")).toBe("Update Creator Toolset on Ana Laptop");
  });

  it("two computers of one person: the one with the originals takes the job and reads them from its disk; two versions at once merge per key (PRD 2)", async () => {
    const at = mark();
    const from = at.hits;
    const ff0 = ffRuns();
    // the look fails each version's first shot once: both fix rounds write shots.json at the same time, on two computers
    answers.lookFails = 2;
    answers.fix = JSON.stringify({ plans: [{ kind: "hard edit", lead: "sources", shots: [{ src: "S2", in: 3, dur: 1 }] }] });
    const held: { who: string; go: () => void }[] = [];
    // the first two looks' results wait for each other (a computer runs one step at a time: so two computers hold them)
    hooks.done = async (who, id) => {
      if (jobRow(id)?.kind !== "critique" || held.length >= 2) return;
      await new Promise<void>((go) => {
        held.push({ who, go });
        if (held.length === 2) for (const h of held) h.go();
      });
    };
    try {
      const workers = [work(studio), work(laptop)];
      await ready(studio, laptop);
      startLoop();
      await until("ana's two versions filed in Review", () => !!review(anas).v1 && !!review(anas).v2 && !active(anas).length, anas, 150_000);
      await stopLoop();
      await finish([studio, laptop], workers);
    } finally {
      delete hooks.done;
    }
    // the script (index and plan) went to the computer that has the originals, which downloaded nothing
    expect(ranBy(anas, "script", at)).toEqual(["studio-mac"]);
    expect(footage("studio-mac", from)).toEqual({});
    // the two first looks were held at once, one on each computer
    expect(held.map((h) => h.who).sort()).toEqual(["ana-laptop", "studio-mac"]);
    // each fix round's shots.json key survived the other's
    const shots = srv.readStep(anas, "shots") as Record<string, { fix?: unknown }>;
    expect(shots.v1?.fix).toBeTruthy();
    expect(shots.v2?.fix).toBeTruthy();
    expect(review(anas)).toMatchObject({ v1: { by: "ana" }, v2: { by: "ana" } });
    expect(serverDecodes(ff0)).toEqual([]);
  }, 240_000);

  it("a computer set to Off takes nothing while the other can (PRD 2)", async () => {
    const at = mark();
    const from = at.hits;
    setBalance("ana", { server: 0, [studio.id]: 0 });
    try {
      const n = review(anas).v1!.n;
      expect((await call("ana", "POST", `/api/editor/${anas}/drafts/v1/review`, {})).status).toBe(200);
      const workers = [work(studio), work(laptop)];
      await ready(studio, laptop);
      startLoop();
      await until("filed again", () => review(anas).v1!.n > n && !active(anas).length, anas);
      await stopLoop();
      await finish([studio, laptop], workers);
    } finally {
      setBalance("ana", { server: 0 });
    }
    expect(ranBy(anas, "preview", at)).toEqual(["ana-laptop"]);
    expect(hits.slice(from).filter((h) => h.who === "studio-mac" && !h.path.endsWith("/work/claim"))).toEqual([]);
  }, 120_000);

  it("a lost lease applies nothing: the computer stops and sends no result", async () => {
    const from = hits.length;
    const preview = path.join(S, "editor", anas, "previews", "v2.mp4");
    const before = { sha: existsSync(preview) ? sha(preview) : null, review: review(anas).v2 };
    let jobId = 0;
    hooks.put = async (who, id) => {
      if (jobId) return;
      jobId = id;
      // Stop on the page while the computer sends its preview: the lease is gone
      const at = hits.length;
      await call("ana", "POST", `/api/editor/${anas}/stop`, {});
      // the next beat answers ok: false; the worker stops the step (this upload with it)
      await until("a beat after the stop", () => hits.slice(at).some((h) => h.path === `/api/devices/relay/work/${id}/beat` && h.who === who));
      await sleep(100);
    };
    try {
      expect((await call("ana", "POST", `/api/editor/${anas}/drafts/v2/review`, {})).status).toBe(200);
      const workers = [work(studio), work(laptop)];
      await ready(studio, laptop);
      startLoop();
      await until("stopped", () => !!jobId && !active(anas).length, anas);
      await stopLoop();
      await finish([studio, laptop], workers);
    } finally {
      delete hooks.put;
    }
    expect(jobRow(jobId)).toMatchObject({ kind: "preview", state: "failed", error: "Stopped" });
    expect(hits.slice(from).filter((h) => h.path.startsWith(`/api/devices/relay/work/${jobId}/`) && /\/(done|fail)$/.test(h.path))).toEqual([]);
    expect(existsSync(preview) ? sha(preview) : null).toBe(before.sha);
    expect(review(anas).v2).toEqual(before.review);
  }, 120_000);
});
