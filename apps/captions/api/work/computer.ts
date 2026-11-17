import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
// the bundle's banner declares createRequire itself (package.json build), so not a named import
import nodeModule from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { WORK_V, type WorkClaim, type WorkOffline, type WorkOutcome, type WorkPackage, type WorkResult, type WorkTable } from "../../contracts/work";
import { Waiting } from "../editor/analyze";
import { editDir, readEdit } from "../editor/store";
import { limitWait, markRead, STEPS } from "../editor/worker";
import { env } from "../lib/env";
import { pluginEditorSteps } from "../lib/plugin";
import { libraryDb } from "../library/db";
import type { JobRow } from "../library/jobs";
import { NeedsKey } from "../library/transcribe";
import { cacheReport, dropProxies, setCacheAccount, emptyCache, proxyPath, setKeptOffline, sizeOf, touchProxy, trimCache } from "./cache";
import { resolveFiles, type Progress } from "./files";
import { cancelLibraryJob, runLibraryJob, runPictureJob, scratchRoom, sweepScratch } from "./library";
import { claimLook, looksHere } from "./look";
import { machineNow } from "./machine";
import { turnOff, turnOn, type WorkServer } from "./on-computer";

/**
 * The computer worker (design 2.4, 3): a computer signed in to a server by address runs that server's video steps for
 * its own account, one at a time, with the unchanged step code, against a working copy in DATA_DIR seeded from the
 * package. It claims with a long poll, beats every 10 s (5 s while downloading), and sends the edit folder's changes
 * back. A beat answered ok: false (Stop on the page, the lease lost) stops the step and sends nothing. Started by
 * api/boot.ts with CT_WORKER=<server address>; it ends after 10 minutes with nothing to do.
 * The proxy cache (cache.ts): each claim reports it; the answer may say to empty it and lists the proxies kept offline,
 * which download one at a time while no step waits. After each step the size limit removes the least recently used.
 */

export interface WorkerOptions {
  /** the server's address, e.g. https://studio.example.com */
  server: string;
  /** the device token (ctd_…) */
  token: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  beatMs?: number;
  downloadBeatMs?: number;
  idleMs?: number;
  /** wait after a claim that failed (server away) */
  retryMs?: number;
}

export const STOPPED_LINE = "Creator Toolset stopped while it ran this step";
const heldFile = () => path.join(env.dataDir, "held.json");

/**
 * What the Mac app's menu shows (apps/mac Worker.swift reads stdout): one line per change, `[work:status] {…}` with the
 * edit and the download's bytes and time left, `[work:status] null` once the step ends. Only in a worker process.
 */
export const STATUS = "[work:status] ";
const tell = (s: string) => {
  if (process.env.CT_WORKER) process.stdout.write(`${STATUS}${s}\n`);
};

export const client = (o: WorkerOptions) => {
  const f = o.fetch ?? fetch;
  const url = (p: string) => `${o.server.replace(/\/$/, "")}/api/devices/relay/${p}`;
  const auth = { authorization: `Bearer ${o.token}` };
  return {
    url,
    auth,
    raw: (p: string, init: RequestInit = {}) => f(url(p), { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } }),
    async post<T>(p: string, body: unknown, signal?: AbortSignal): Promise<T> {
      const res = await f(url(p), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body), signal });
      const json = (await res.json().catch(() => null)) as T | null;
      if (json === null) throw new Error(`The server answered ${res.status}`);
      return json;
    },
  };
};

/** A step's throw, filed as the server's runStep files it (editor/worker.ts). */
export function classify(e: unknown, now = Date.now()): WorkOutcome {
  if (e instanceof Waiting) return { wait: { seconds: e.seconds, ...(e.line ? { line: e.line } : {}) } };
  const hold = limitWait(e, now);
  if (hold) return { limit: hold };
  if (e instanceof NeedsKey) return { needsKey: e.message };
  return { error: e instanceof Error ? e.message : String(e) };
}

/** A held.json left by a run that never finished (a crash, a quit mid-step): that step is reported failed. */
export async function reportLeftover(o: WorkerOptions): Promise<void> {
  if (!existsSync(heldFile())) return;
  const id = Number((JSON.parse(readFileSync(heldFile(), "utf8") || "{}") as { id?: unknown }).id);
  if (Number.isInteger(id)) await client(o).post(`work/${id}/fail`, { error: STOPPED_LINE });
  rmSync(heldFile(), { force: true });
}

/** Whether this computer can run search by picture's model: the model runtime came with this app (onnxruntime-node). */
const runsPictureModel = (): boolean => {
  try {
    nodeModule.createRequire(import.meta.url).resolve("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
};

/**
 * CT_WORKER_KINDS=library: a computer that takes only Media Library jobs (a headless Linux box beside the Mac): no editor
 * step, no pictures. It sweeps its scratch at start (one job at a time, so none is live) and asks for no job while its
 * disk has less than CT_LIBRARY_SCRATCH_GB (20) free.
 */
export const libraryOnly = () => process.env.CT_WORKER_KINDS === "library";

/** Claims and runs steps until 10 minutes pass with none, or the server asks for a newer app. */
export async function startComputerWorker(o: WorkerOptions): Promise<"idle" | "update"> {
  const c = client(o);
  const only = libraryOnly();
  await reportLeftover(o).catch((e) => console.warn("[work] leftover step:", e));
  if (only) await sweepScratch();
  let idleSince = Date.now();
  while (Date.now() - idleSince < (o.idleMs ?? 10 * 60_000)) {
    if (only && !(await scratchRoom())) {
      console.warn("[work] too little free disk for library work; asking again in a minute");
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    // a look of a file on a share this computer connects (look.ts): a Linux library worker only
    if (looksHere() && (await claimLook(c).catch((e) => void console.warn("[work] look:", e instanceof Error ? e.message : e)))) {
      idleSince = Date.now();
      continue;
    }
    let claim: WorkClaim;
    try {
      claim = await c.post<WorkClaim>("work/claim", {
        v: WORK_V,
        steps: only ? [] : pluginEditorSteps().map((s) => s.id),
        cache: cacheReport(),
        library: true,
        ...(only ? { libraryOnly: true } : runsPictureModel() ? { pictures: true } : {}),
        machine: await machineNow(),
      });
    } catch (e) {
      console.warn("[work] claim:", e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, o.retryMs ?? 5000));
      continue;
    }
    if (claim.account) setCacheAccount(claim.account);
    if (claim.offline) setKeptOffline(claim.offline.map((f) => f.id));
    if (claim.empty) emptyCache();
    if (claim.drop) dropProxies(claim.drop);
    if (claim.pkg) {
      await runJob(claim.pkg, o);
      trimCache();
      idleSince = Date.now();
    } else if (claim.lib && claim.lib.v > WORK_V) {
      // a package newer than this worker reads: handed back, and the worker stops for an update
      await c.post(`work/lib/${claim.lib.job.id}/fail`, { error: "This computer needs a newer Creator Toolset" }).catch(() => {});
      return "update";
    } else if (claim.lib) {
      await runLibraryJob(claim.lib, o);
      idleSince = Date.now();
    } else if (claim.pics) {
      await runPictureJob(claim.pics, o);
      idleSince = Date.now();
    } else if ("update" in claim && claim.update) {
      console.log("[work] the server needs a newer Creator Toolset to hand it steps");
      return "update";
    } else if (claim.offline && (await keepOffline(claim.offline, o))) idleSince = Date.now();
  }
  return "idle";
}

/**
 * Downloads one proxy kept offline that the cache lacks, from the server's offline route; the next claim comes first,
 * so a step never waits for more than one. Cancel (the menu) stops it and keeps the `.part`. True when it downloaded one.
 */
export async function keepOffline(list: WorkOffline[], o: WorkerOptions): Promise<boolean> {
  const f = list.find((x) => x.bytes > 0 && sizeOf(proxyPath(x.id)) !== x.bytes);
  if (!f) return false;
  const c = client(o);
  const ctl = new AbortController();
  current = { ctl, cancelled: false };
  try {
    await resolveFiles(
      { files: [{ id: f.id, title: f.title, bytes: 0, proxy: { bytes: f.bytes } }] },
      { folders: [], get: (v, init) => c.raw(`work/offline/${encodeURIComponent(v)}`, init), signal: ctl.signal },
    );
    return true;
  } catch (e) {
    if (!ctl.signal.aborted) console.warn(`[work] keeping ${f.title} offline:`, e instanceof Error ? e.message : e);
    return false;
  } finally {
    current = null;
  }
}

/** The running step, for Cancel (the menu): it ends as "Stopped". */
let current: { ctl: AbortController; cancelled: boolean } | null = null;
export function cancelStep(): void {
  cancelLibraryJob();
  if (!current) return;
  current.cancelled = true;
  current.ctl.abort();
}

const ORDER: WorkTable[] = ["libraries", "assets", "asset_versions", "asset_tags", "descriptions", "transcripts", "stretches", "derivatives", "edit_jobs"];

/** Replaces the local library rows with the package's, in one transaction, on the same schema (columns this app lacks are left out). */
export function seedRows(pkg: Pick<WorkPackage, "rows">): void {
  const db = libraryDb();
  db.exec("PRAGMA foreign_keys = OFF"); // the rows are the job's slice, not the whole graph
  db.exec("BEGIN");
  try {
    for (const t of [...ORDER].reverse()) db.exec(`DELETE FROM ${t}`);
    for (const t of ORDER) {
      const cols = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name));
      for (const row of pkg.rows[t] ?? []) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        const vals = keys.map((k) => {
          const v = row[k];
          return typeof v === "boolean" ? Number(v) : v !== null && typeof v === "object" ? JSON.stringify(v) : (v as string | number | null);
        });
        db.prepare(`INSERT INTO ${t} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...vals);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** `rel` inside `root`, or an error: nothing the server names may land outside it. */
function inside(root: string, rel: string): string {
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) throw new Error(`Not a path in the edit: ${rel}`);
  return p;
}

const editorRoot = () => path.join(env.dataDir, "editor");
const cacheDir = () => path.join(editorRoot(), "cache");

/** Every file under `dir` (relative, "/" separators), leaving out `skip` at the top. */
function walk(dir: string, skip = new Set<string>()): string[] {
  let all: string[] = [];
  try {
    all = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return all
    .map((r) => r.split(path.sep).join("/"))
    .filter((r) => !skip.has(r.split("/")[0]!) && statSync(path.join(dir, r)).isFile());
}

const stamp = (file: string) => {
  const s = statSync(file);
  return `${s.size}:${s.mtimeMs}`;
};

/**
 * Lays out the edit folder from the package. Other edits' folders go, except their post copies (`post/`), which stay on
 * the computer that made them for the preview that plays them; so does this edit's. The editor caches are kept.
 */
async function layOut(pkg: WorkPackage, own: (rel: string) => Promise<Response>): Promise<void> {
  mkdirSync(editorRoot(), { recursive: true });
  for (const name of readdirSync(editorRoot())) {
    if (name === "cache") continue;
    const dir = path.join(editorRoot(), name);
    if (!statSync(dir).isDirectory()) continue;
    for (const e of readdirSync(dir)) if (e !== "post") rmSync(path.join(dir, e), { recursive: true, force: true });
  }
  const dir = editDir(pkg.job.editId);
  for (const [rel, text] of Object.entries(pkg.edit)) {
    const p = inside(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
  }
  // ponytail: own files are fetched again each step; keep them by sha256 if previews get large
  for (const f of pkg.own) {
    const p = inside(dir, f.path);
    const res = await own(f.path);
    if (!res.ok) throw new Error(`Could not get ${f.path} from the server (${res.status})`);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, Buffer.from(await res.arrayBuffer()));
  }
  mkdirSync(cacheDir(), { recursive: true });
  for (const [name, b64] of Object.entries(pkg.caches)) await writeFile(inside(cacheDir(), name), Buffer.from(b64, "base64"));
}

/** What the step changed: JSON files against the package, media and caches against the stamps taken before it ran. */
function diff(pkg: WorkPackage, before: Map<string, string>, queuedBefore: Map<number, string>): Omit<WorkResult, "v" | "outcome" | "effects"> & { queue: { version: string; kind: string }[] } {
  const dir = editDir(pkg.job.editId);
  const now = walk(dir, new Set(["post"]));
  const put: Record<string, string> = {};
  const uploads: string[] = [];
  for (const rel of now) {
    if (rel.endsWith(".json")) {
      const text = readFileSync(path.join(dir, rel), "utf8");
      if (pkg.edit[rel] !== text) put[rel] = text;
    } else if (before.get(rel) !== stamp(path.join(dir, rel))) uploads.push(`editor/${pkg.job.editId}/${rel}`);
  }
  for (const name of walk(cacheDir()).filter((r) => !r.includes("/"))) {
    const rel = `editor/cache/${name}`;
    if (before.get(rel) !== stamp(path.join(cacheDir(), name))) uploads.push(rel);
  }
  const gone = Object.keys(pkg.edit).filter((rel) => !rel.startsWith("post/") && !now.includes(rel));
  const queue = (libraryDb().prepare("SELECT id, version_id, kind, state FROM edit_jobs WHERE state = 'queued'").all() as { id: number; version_id: string; kind: string }[])
    .filter((r) => queuedBefore.get(r.id) !== "queued")
    .map((r) => ({ version: r.version_id, kind: r.kind }));
  return { edit: { put, gone }, uploads, queue };
}

/** A path as the result names files: relative to DATA_DIR, "/" separators. */
const dataRel = (p: string) => (path.isAbsolute(p) ? path.relative(env.dataDir, p).split(path.sep).join("/") : p);

/** Runs one claimed step to the end: done/fail sent, or nothing when the server took it back. */
export async function runJob(pkg: WorkPackage, o: WorkerOptions): Promise<"done" | "failed" | "stopped"> {
  const c = client(o);
  const id = pkg.job.id;
  const ctl = new AbortController();
  const me = (current = { ctl, cancelled: false });
  let taken = false; // a beat said the server no longer holds it
  const beat: { line?: string } & Partial<Progress> = {};
  let downloading = false;
  const review: { value?: WorkResult["effects"]["review"] } = {};
  writeFileSync(heldFile(), JSON.stringify({ id }));
  const name = (() => {
    try {
      return String((JSON.parse(pkg.edit["edit.json"] ?? "{}") as { name?: unknown }).name ?? "");
    } catch {
      return "";
    }
  })();
  let told = "";
  const show = () => {
    const s = JSON.stringify({ editId: pkg.job.editId, edit: name, line: beat.line, done: beat.done, total: beat.total, leftS: beat.leftS });
    if (s !== told) tell((told = s));
  };
  const shown = setInterval(show, 1000);
  show();

  let timer: NodeJS.Timeout | undefined;
  const beatLoop = () => {
    timer = setTimeout(
      async () => {
        try {
          const r = await c.post<{ ok: boolean }>(`work/${id}/beat`, { line: beat.line, done: beat.done, total: beat.total, leftS: beat.leftS });
          if (r.ok === false) {
            taken = true;
            ctl.abort();
            return;
          }
        } catch {
          // the server is away a moment: the lease outlives a few missed beats
        }
        if (!ctl.signal.aborted) beatLoop();
      },
      downloading ? (o.downloadBeatMs ?? 5000) : (o.beatMs ?? 10_000),
    );
  };
  beatLoop();

  const server: WorkServer & { review(r: NonNullable<WorkResult["effects"]["review"]>): void } = {
    ai: (body) => c.post(`work/${id}/ai`, body, ctl.signal),
    call: (fn, args) => c.post(`work/${id}/call`, { fn, args }, ctl.signal),
    say: (line) => void (beat.line = line),
    review: (r) => void (review.value = r),
  };

  const ended = async (r: "done" | "failed" | "stopped", send?: () => Promise<unknown>) => {
    if (send && !taken) await send().catch((e) => console.warn(`[work] step ${id}:`, e instanceof Error ? e.message : e));
    return r;
  };
  try {
    const step = STEPS[pkg.job.kind];
    if (!step) throw new Error(`No ${pkg.job.kind} step yet`);
    downloading = true;
    const paths = await resolveFiles(pkg, {
      folders: pkg.folders ?? [],
      get: (version, init) => c.raw(`editor/job/${id}/footage/${encodeURIComponent(version)}`, init),
      signal: ctl.signal,
      progress: (p) => Object.assign(beat, p),
    });
    downloading = false;
    for (const k of ["done", "total", "leftS"] as const) delete beat[k];
    for (const p of Object.values(paths)) touchProxy(p);

    seedRows(pkg);
    await layOut(pkg, (rel) => c.raw(`work/${id}/own?path=${encodeURIComponent(rel)}`, { signal: ctl.signal }));
    const dir = editDir(pkg.job.editId);
    const before = new Map<string, string>([
      ...walk(dir, new Set(["post"])).map((r) => [r, stamp(path.join(dir, r))] as [string, string]),
      ...walk(cacheDir()).map((r) => [`editor/cache/${r}`, stamp(path.join(cacheDir(), r))] as [string, string]),
    ]);
    const queuedBefore = new Map((libraryDb().prepare("SELECT id, state FROM edit_jobs").all() as { id: number; state: string }[]).map((r) => [r.id, r.state]));
    const job = (libraryDb().prepare("SELECT * FROM edit_jobs WHERE id = ?").get(id) as JobRow | undefined) ?? {
      id,
      library_id: pkg.job.workspaceId,
      version_id: `${pkg.job.editId}:${pkg.job.variant}`,
      kind: pkg.job.kind,
      state: "running",
      attempts: 1,
      run_after: 0,
      lease_until: null,
      actor: pkg.job.actor,
      error: null,
    };
    const edit = readEdit(pkg.job.editId);
    if (!edit) throw new Error("The edit is gone");

    // lost while the files came (a beat said so, or Cancel): the step never starts
    ctl.signal.throwIfAborted();
    let outcome: WorkOutcome = { done: true };
    turnOn(pkg, paths, server);
    try {
      await step({ edit, job, variant: pkg.job.variant, signal: ctl.signal });
      if (job.kind === "script") await markRead(edit);
    } catch (e) {
      outcome = classify(e);
    } finally {
      turnOff();
    }
    if (ctl.signal.aborted) throw ctl.signal.reason;

    const { edit: changed, uploads: listed, queue } = diff(pkg, before, queuedBefore);
    // Review's thumbnail and waveform made here go up as files, not as edit JSON
    const rv = review.value && { ...review.value, thumb: dataRel(review.value.thumb), wave: dataRel(review.value.wave) };
    for (const p of [rv?.thumb, rv?.wave]) {
      if (!p) continue;
      if (!listed.includes(p)) listed.push(p);
      if (p.startsWith(`editor/${pkg.job.editId}/`)) delete changed.put[p.slice(`editor/${pkg.job.editId}/`.length)];
    }
    const uploads: string[] = [];
    for (const rel of listed) {
      const file = path.join(env.dataDir, rel);
      const res = await c.raw(`work/${id}/file?path=${encodeURIComponent(rel)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(statSync(file).size) },
        body: Readable.toWeb(createReadStream(file)) as ReadableStream,
        signal: ctl.signal,
        duplex: "half",
      } as RequestInit);
      // the server files what it accepted and skips the rest (api/work/result.ts)
      if (res.ok) uploads.push(rel);
      else console.warn(`[work] step ${id}: the server refused ${rel} (${res.status})`);
    }
    let kept: Record<string, string> | undefined;
    if (pkg.job.kind === "post" && changed.put["post.json"]) kept = (JSON.parse(changed.put["post.json"]) as Record<string, { files?: Record<string, string> }>)[pkg.job.variant]?.files;
    const result: WorkResult = {
      v: WORK_V,
      outcome,
      edit: changed,
      uploads,
      ...(kept ? { kept } : {}),
      effects: { ...(queue.length ? { queue } : {}), ...(rv ? { review: rv } : {}) },
    };
    return await ended("done", () => c.post(`work/${id}/done`, result));
  } catch (e) {
    if (ctl.signal.aborted) return ended("stopped", me.cancelled ? () => c.post(`work/${id}/fail`, { error: "Stopped" }) : undefined);
    return ended("failed", () => c.post(`work/${id}/fail`, { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    clearTimeout(timer);
    clearInterval(shown);
    tell("null");
    ctl.abort(); // ends a beat in flight's loop
    current = null;
    rmSync(heldFile(), { force: true });
  }
}
