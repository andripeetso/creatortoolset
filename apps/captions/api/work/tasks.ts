import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono, type Context } from "hono";
import type { Device } from "../../contracts/providers";
import { WORK_V, type TaskPackage } from "../../contracts/work";
import { offOf } from "../lib/balance";
import { deviceForToken, isOnline, listDevices, touchDevice } from "../lib/devices";
import { env } from "../lib/env";
import { libraryDb } from "../library/db";
import { MAX_ATTEMPTS, WAITS_FOR_COMPUTER } from "../library/jobs";
import type { WorkerOptions } from "./computer";
import { mayRunHere } from "./may-run";
import { takeTurn, TURN_LINE } from "./turn";
import { serverKind, serverWeight, serverWorks } from "./server-work";

/**
 * Computer tasks (local-first plan D7, P3): the processing a tool does outside the Media Library and the AI Editor (a
 * Caption Studio proxy, an export, a Review frame, a clip's sound) as one kind each, run by the same code on whichever
 * machine mayRunHere picks. A tool calls startTask: on This Mac, or where Settings → Server's video work is on and no
 * computer of the asker can take it, the server runs it now; otherwise it is queued (durable, a restart keeps it) for
 * one of the asker's computers, whose worker claims it (POST work/claim, `task`), and it waits with one line while none
 * is online. It never falls through to the server. Whichever ran it, the kind's `apply` files the result on the server.
 * A kind's module lives in api/work/tasks/ and registers itself with taskKind(); only this file and task-kinds.ts may
 * import one (prevention.test.ts), so no tool runs a kind's work without this gate.
 */

export interface TaskCtx {
  /** the task's own folder: made files go here, named as `run` lists them; removed when the task ends */
  dir: string;
  /** an input file by name: where this machine has it (the input's `paths`), else downloaded from the server into `dir` */
  file(name: string): Promise<string>;
  /** a server call the kind defines (`calls`), as the task's account: a provider hearing sound cut here, a read */
  call(name: string, body: unknown): Promise<unknown>;
  /** progress for the tool's line; it also keeps the computer's hold */
  beat(line?: string): void;
  signal: AbortSignal;
  /** "server" when the server runs it (This Mac, or its video work on), "computer" on a computer's worker */
  where: "server" | "computer";
}

export interface TaskRow {
  id: number;
  kind: string;
  /** what the task is for, unique per kind: a new start of the same ref replaces a queued or finished one */
  ref: string;
  actor: string;
  workspace: string | null;
  input: unknown;
  state: "queued" | "running" | "done" | "failed";
  attempts: number;
  held_by: string | null;
  claim_id: string | null;
  error: string | null;
  line: string | null;
  created_at: number;
}

export interface TaskKind<I = unknown, R = unknown> {
  /** it decodes video or sound (default): mayRunHere keeps it off the server unless video work is on */
  reads?: boolean;
  /** it writes on the asker's computer: never run on the server (its video work on or not), it waits for a computer */
  onComputer?: boolean;
  /** how long it may wait for a computer: queued longer, it fails for good with TASK_EXPIRED (its `failed` tells) */
  ttlMs?: number;
  /** the work itself, the same code on the server and on a computer; `files` names what it made in ctx.dir */
  run(input: I, ctx: TaskCtx): Promise<{ result: R; files?: string[] }>;
  /** server: where input file `name` is on the server, for a computer that lacks it and for the server's own run */
  serve?(t: TaskRow, name: string): string | undefined;
  /** server: files the result (made file name → its path here, which apply may move) */
  apply(t: TaskRow & { input: I }, result: R, files: Record<string, string>): Promise<void> | void;
  /** server: it failed for good (three tries, or a refusal); the tool shows its error */
  failed?(t: TaskRow & { input: I }, error: string): void;
  /** server: calls a computer may make while it holds the task */
  calls?: Record<string, (t: TaskRow & { input: I }, body: unknown) => Promise<unknown>>;
  /** which of the asker's computers may take it (default: any whose worker runs this kind) */
  can?(d: Device, t: TaskRow & { input: I }): boolean;
}

const kinds = new Map<string, TaskKind>();

/** The error a task that waited past its kind's ttlMs fails with. */
export const TASK_EXPIRED = "expired";

/** Registers a kind (each module in api/work/tasks/ at load). */
export function taskKind<I, R>(kind: string, def: TaskKind<I, R>): void {
  kinds.set(kind, def as TaskKind);
}

/** The kinds this worker runs: sent with each claim, so a server never hands a computer a kind it lacks. */
export const taskKinds = (): string[] => [...kinds.keys()].sort();

const LEASE_MS = 5 * 60_000;
const BACKOFF_MS = 60_000;
const FILE_MAX = 8 * 1024 ** 3;
const NAME = /^[\w][\w.-]{0,80}$/;

let made = false;
const db = () => {
  const d = libraryDb();
  if (!made) {
    d.exec(`CREATE TABLE IF NOT EXISTS computer_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, actor TEXT NOT NULL, workspace TEXT,
      input TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER, held_by TEXT, claim_id TEXT, error TEXT, line TEXT, created_at INTEGER NOT NULL, done_at INTEGER,
      UNIQUE (kind, ref))`);
    made = true;
  }
  return d;
};

type Raw = Omit<TaskRow, "input"> & { input: string };
const rowOf = (r: Raw | undefined): TaskRow | undefined => (r ? { ...r, input: JSON.parse(r.input) as unknown } : undefined);
export const taskOf = (id: number): TaskRow | undefined => rowOf(db().prepare("SELECT * FROM computer_tasks WHERE id = ?").get(id) as Raw | undefined);
export const taskFor = (kind: string, ref: string): TaskRow | undefined =>
  rowOf(db().prepare("SELECT * FROM computer_tasks WHERE kind = ? AND ref = ?").get(kind, ref) as Raw | undefined);

const works = (d: Device, kind: string): boolean => !!d.work?.tasks?.includes(kind) && !d.work.libraryOnly;

/** The asker's online computers that may take task `t` now. */
function takers(t: TaskRow): Device[] {
  const def = kinds.get(t.kind);
  const off = offOf(t.actor);
  return listDevices((d) => d.owner === t.actor && isOnline(d.id) && !off.has(d.id) && works(d, t.kind) && (def?.can?.(d, t) ?? true));
}

/** Where task `t` runs now (the one rule, place.ts mayRunHere). This Mac is the person's own computer: always here. */
export function placeTask(t: Pick<TaskRow, "kind" | "actor" | "workspace"> & Partial<TaskRow>): "server" | "computer" | "wait" {
  if (serverKind() === "local") return "server";
  const row = { id: 0, ref: "", input: null, state: "queued", attempts: 0, held_by: null, claim_id: null, error: null, line: null, ...t } as TaskRow;
  return mayRunHere({
    reads: kinds.get(t.kind)?.reads !== false,
    open: () => !kinds.get(t.kind)?.onComputer && serverWorks(t.workspace, t.actor) && serverWeight(t.actor) > 0,
    computer: () => takers(row).length > 0,
  });
}

/** The line a queued task shows: undefined while a computer can take it (it is about to), else the wait line (R6). */
export function taskWaitLine(t: TaskRow): string | undefined {
  if (t.state !== "queued") return undefined;
  return takers(t).length ? undefined : WAITS_FOR_COMPUTER;
}

export type Started<R> = { state: "done"; result: R } | { state: "queued"; id: number; line?: string };

/**
 * Starts task `kind` for `ref`: run now on the server where mayRunHere says so (its apply runs before this returns, and a
 * failure throws), else queued for a computer, with the wait line when none can take it now.
 */
export async function startTask<I, R>(kind: string, ref: string, actor: string, workspace: string | null, input: I): Promise<Started<R>> {
  const def = kinds.get(kind);
  if (!def) throw new Error(`No task kind ${kind}`);
  const d = db();
  const place = placeTask({ kind, actor, workspace, input });
  const now = Date.now();
  // a new start replaces what the ref had, unless a computer holds it now (its result would be filed half over the new one)
  const row = d
    .prepare(
      `INSERT INTO computer_tasks (kind, ref, actor, workspace, input, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)
       ON CONFLICT (kind, ref) DO UPDATE SET actor = excluded.actor, workspace = excluded.workspace, input = excluded.input,
         state = 'queued', attempts = 0, run_after = 0, lease_until = NULL, held_by = NULL, claim_id = NULL, error = NULL, line = NULL,
         created_at = excluded.created_at
       WHERE computer_tasks.state <> 'running'
       RETURNING id`,
    )
    .get(kind, ref, actor, workspace, JSON.stringify(input ?? null), now) as { id: number } | undefined;
  const id = row?.id ?? taskFor(kind, ref)!.id;
  if (place === "server") {
    const t = claimHere(id, now);
    if (!t) return { state: "queued", id };
    return { state: "done", result: (await runOnServer(t)) as R };
  }
  const t = taskOf(id)!;
  const line = taskWaitLine(t);
  if (line) d.prepare("UPDATE computer_tasks SET line = ? WHERE id = ? AND state = 'queued'").run(line, id);
  return { state: "queued", id, ...(line ? { line } : {}) };
}

/**
 * For a tool that needs the answer within its request (a picture made smaller for an AI to read): waits up to `ms` for
 * a queued task a computer is about to take. "done" once its apply ran, "failed", or "waiting" when no computer took it
 * in time (the caller says so; it never runs it here instead).
 */
export async function awaitTask(id: number, ms: number): Promise<"done" | "failed" | "waiting"> {
  for (const end = Date.now() + ms; ; ) {
    const s = taskOf(id)?.state;
    if (s === "done" || s === "failed") return s;
    if (!s || Date.now() >= end) return "waiting";
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Stops a queued task (the tool's Cancel or Delete): a computer that holds one loses it at its next beat. */
export function dropTask(kind: string, ref: string): void {
  db().prepare("DELETE FROM computer_tasks WHERE kind = ? AND ref = ?").run(kind, ref);
}

function claimHere(id: number, now: number): TaskRow | undefined {
  return rowOf(
    db()
      .prepare(
        `UPDATE computer_tasks SET state = 'running', held_by = 'server', claim_id = NULL, lease_until = ?, attempts = attempts + 1, line = NULL
         WHERE id = ? AND state = 'queued' RETURNING *`,
      )
      .get(now + LEASE_MS, id) as Raw | undefined,
  );
}

const incoming = (id: number) => path.join(env.dataDir, "tasks", String(id));

/** The server runs task `t` itself (it holds it): the kind's run, then its apply. A throw fails the try and is thrown on. */
async function runOnServer(t: TaskRow): Promise<unknown> {
  const def = kinds.get(t.kind)!;
  const dir = incoming(t.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const ac = new AbortController();
  try {
    const out = await def.run(t.input, {
      dir,
      where: "server",
      signal: ac.signal,
      file: async (name) => {
        const p = def.serve?.(t, name);
        if (!p || !existsSync(p)) throw new Error(`The ${name} is not on the server`);
        return p;
      },
      call: async (name, body) => {
        const fn = def.calls?.[name];
        if (!fn) throw new Error(`No call ${name}`);
        return fn(t, body);
      },
      beat: () => void db().prepare("UPDATE computer_tasks SET lease_until = ? WHERE id = ? AND held_by = 'server'").run(Date.now() + LEASE_MS, t.id),
    });
    const files = Object.fromEntries((out.files ?? []).map((n) => [n, path.join(dir, n)]));
    await def.apply(t, out.result, files);
    finish(t.id, "server");
    return out.result;
  } catch (e) {
    fail(t, e instanceof Error ? e.message : String(e), true);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const finish = (id: number, holder: string) =>
  db().prepare("UPDATE computer_tasks SET state = 'done', lease_until = NULL, error = NULL, line = NULL, done_at = ? WHERE id = ? AND held_by = ? AND state = 'running'").run(Date.now(), id, holder);

/** A failed try: queued again after a backoff, or failed for good after three (or at once: `final`), the tool told. */
function fail(t: TaskRow, error: string, final = false): void {
  const last = final || t.attempts >= MAX_ATTEMPTS;
  const changed = db()
    .prepare(
      `UPDATE computer_tasks SET state = ?, error = ?, lease_until = NULL, held_by = NULL, claim_id = NULL, run_after = ?
       WHERE id = ? AND state = 'running'`,
    )
    .run(last ? "failed" : "queued", error.slice(0, 500), last ? 0 : Date.now() + BACKOFF_MS * t.attempts, t.id).changes;
  if (changed && last) kinds.get(t.kind)?.failed?.(t, error.slice(0, 500));
}

/** The task computer `d` takes now, with its package, or null: its owner's oldest queued one of a kind it runs. */
export function claimTask(d: Device, now = Date.now()): TaskPackage | null {
  const mine = d.work?.tasks?.filter((k) => kinds.has(k)) ?? [];
  if (!mine.length || d.work?.libraryOnly || offOf(d.owner).has(d.id)) return null;
  expire(now);
  const rows = (
    db()
      .prepare(`SELECT * FROM computer_tasks WHERE state = 'queued' AND run_after <= ? AND actor = ? AND kind IN (${mine.map(() => "?").join(", ")}) ORDER BY id LIMIT 50`)
      .all(now, d.owner, ...mine) as unknown as Raw[]
  ).map((r) => rowOf(r)!);
  for (const t of rows) {
    if (!(kinds.get(t.kind)!.can?.(d, t) ?? true)) continue;
    const claim = randomUUID();
    const got = db()
      .prepare(
        `UPDATE computer_tasks SET state = 'running', held_by = ?, claim_id = ?, lease_until = ?, attempts = attempts + 1, line = NULL
         WHERE id = ? AND state = 'queued' RETURNING id`,
      )
      .get(d.id, claim, now + LEASE_MS, t.id);
    if (got) return { v: WORK_V, task: { id: t.id, kind: t.kind, claim, actor: t.actor }, input: t.input };
  }
  return null;
}

/** Whether a task waits that computer `d` would be handed now: its device runner's long poll starts the worker. */
export function tasksWait(d: Device, now = Date.now()): boolean {
  const mine = d.work?.tasks?.filter((k) => kinds.has(k)) ?? [];
  if (!mine.length || d.work?.libraryOnly || offOf(d.owner).has(d.id)) return false;
  return (
    db()
      .prepare(`SELECT * FROM computer_tasks WHERE state = 'queued' AND run_after <= ? AND actor = ? AND kind IN (${mine.map(() => "?").join(", ")}) LIMIT 50`)
      .all(now, d.owner, ...mine) as unknown as Raw[]
  ).some((r) => kinds.get(r.kind)!.can?.(d, rowOf(r)!) ?? true);
}

/** A hold whose computer stopped beating: tried again (or failed after three). */
function expire(now: number): void {
  const gone = db().prepare("SELECT * FROM computer_tasks WHERE state = 'running' AND lease_until < ?").all(now) as unknown as Raw[];
  for (const r of gone) fail(rowOf(r)!, "The computer stopped while it ran this");
}

/**
 * The server's own pass, every 20 s (boot.ts): holds that expired are tried again, and a queued task the server may now
 * run (its video work was switched on, and no computer can take it) is run here, one at a time.
 */
let ticking = false;
export async function taskTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    expire(now);
    const queued = (db().prepare("SELECT * FROM computer_tasks WHERE state = 'queued' AND run_after <= ? ORDER BY id LIMIT 50").all(now) as unknown as Raw[]).map((r) => rowOf(r)!);
    for (const t of queued) {
      if (!kinds.has(t.kind)) continue;
      const ttl = kinds.get(t.kind)!.ttlMs;
      if (ttl && now - t.created_at > ttl) {
        const gone = db().prepare("UPDATE computer_tasks SET state = 'failed', error = ?, line = NULL WHERE id = ? AND state = 'queued'").run(TASK_EXPIRED, t.id).changes;
        if (gone) kinds.get(t.kind)!.failed?.(t, TASK_EXPIRED);
        continue;
      }
      if (placeTask(t) !== "server") {
        const line = taskWaitLine(t) ?? null;
        if (line !== t.line) db().prepare("UPDATE computer_tasks SET line = ? WHERE id = ? AND state = 'queued'").run(line, t.id);
        continue;
      }
      const held = claimHere(t.id, Date.now());
      if (held) await runOnServer(held).catch((e) => console.warn(`[tasks] ${t.kind}:`, e instanceof Error ? e.message : e));
    }
  } finally {
    ticking = false;
  }
}

export function startTaskTick(): void {
  setInterval(() => void taskTick().catch((e) => console.warn("[tasks]", e)), 20_000).unref();
}

// ---- the routes a computer's worker calls, at /api/devices/relay/work/task (routes.ts), with its ctd_ token ----

function caller(c: Context): Device | null {
  const d = deviceForToken(c.req.header("authorization"));
  if (d) touchDevice(d.id, c.req.header("user-agent"));
  return d;
}

/** The task this computer holds under this claim, or undefined (taken back, dropped, finished). */
function held(c: Context, d: Device): TaskRow | undefined {
  const t = taskOf(Number(c.req.param("id")) || 0);
  return t && t.state === "running" && t.held_by === d.id && t.claim_id === (c.req.header("x-ct-claim") ?? "") ? t : undefined;
}

const GONE = (c: Context) => c.json({ ok: false, error: "This task was taken back" }, 410);

function capped(cap: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      n += chunk.length;
      cb(n > cap ? new Error("Too large") : null, chunk);
    },
  });
}

export const taskWorkApp = new Hono();

taskWorkApp.post("/:id/beat", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const t = held(c, d);
  if (!t) return c.json({ ok: false });
  const b = (await c.req.json().catch(() => null)) as { line?: unknown } | null;
  db()
    .prepare("UPDATE computer_tasks SET lease_until = ?, line = ? WHERE id = ? AND state = 'running'")
    .run(Date.now() + LEASE_MS, typeof b?.line === "string" ? b.line.slice(0, 200) : null, t.id);
  return c.json({ ok: true });
});

/** An input file the task names, for a computer that lacks it: only what the kind's serve gives, only while held. */
taskWorkApp.get("/:id/file", (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const t = held(c, d);
  if (!t) return GONE(c);
  const p = kinds.get(t.kind)?.serve?.(t, c.req.query("name") ?? "");
  if (!p || !existsSync(p)) return c.json({ error: "Not found" }, 404);
  return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, {
    headers: { "content-type": "application/octet-stream", "content-length": String(statSync(p).size) },
  });
});

taskWorkApp.post("/:id/call/:name", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const t = held(c, d);
  if (!t) return GONE(c);
  const fn = kinds.get(t.kind)?.calls?.[c.req.param("name")];
  if (!fn) return c.json({ error: "Not found" }, 404);
  try {
    return c.json({ ok: true, value: (await fn(t, await c.req.json().catch(() => null))) ?? null });
  } catch (e) {
    return c.json({ error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }, 502);
  }
});

taskWorkApp.put("/:id/file", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const t = held(c, d);
  if (!t) return GONE(c);
  const name = c.req.query("name") ?? "";
  const body = c.req.raw.body;
  if (!NAME.test(name) || !body) return c.json({ error: "A file name and its bytes" }, 400);
  await mkdir(incoming(t.id), { recursive: true });
  await pipeline(Readable.fromWeb(body as never), capped(FILE_MAX), createWriteStream(path.join(incoming(t.id), `out-${name}`)));
  return c.json({ ok: true });
});

taskWorkApp.post("/:id/done", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const t = held(c, d);
  if (!t) return GONE(c);
  const b = (await c.req.json().catch(() => null)) as { result?: unknown; files?: unknown } | null;
  const names = Array.isArray(b?.files) ? b.files.filter((n): n is string => typeof n === "string" && NAME.test(n)) : [];
  const dir = incoming(t.id);
  const files: Record<string, string> = {};
  for (const n of names) {
    const p = path.join(dir, `out-${n}`);
    // a result without one of its files would be filed half: the try fails and the task runs again
    if (!existsSync(p)) {
      fail(t, `The computer did not send the ${n}`);
      return c.json({ ok: false });
    }
    files[n] = p;
  }
  try {
    await kinds.get(t.kind)!.apply(t, b?.result ?? null, files);
    finish(t.id, d.id);
    return c.json({ ok: true });
  } catch (e) {
    fail(t, e instanceof Error ? e.message : String(e));
    return c.json({ ok: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

taskWorkApp.post("/:id/fail", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const t = held(c, d);
  if (!t) return GONE(c);
  const b = (await c.req.json().catch(() => null)) as { error?: unknown; final?: unknown } | null;
  fail(t, typeof b?.error === "string" && b.error ? b.error : "Your computer could not run this", b?.final === true);
  await rm(incoming(t.id), { recursive: true, force: true });
  return c.json({ ok: true });
});

// ---- the computer's side: its worker (computer.ts) runs a claimed task ----

type Client = {
  raw: (p: string, init?: RequestInit) => Promise<Response>;
  post<T>(p: string, body: unknown, signal?: AbortSignal): Promise<T>;
};

/** Runs a claimed task on this computer: inputs read where they are or downloaded, made files sent, then done. */
export async function runTaskJob(p: TaskPackage, c: Client, o: Pick<WorkerOptions, "beatMs">): Promise<"done" | "failed" | "stopped"> {
  const base = `work/task/${p.task.id}`;
  const headers = { "x-ct-claim": p.task.claim };
  const raw = (q: string, init: RequestInit = {}) => c.raw(q, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const post = async (q: string, body: unknown) => {
    const res = await raw(q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  };
  const def = kinds.get(p.task.kind);
  if (!def) {
    await post(`${base}/fail`, { error: "This computer needs a newer Creator Toolset" }).catch(() => {});
    return "failed";
  }
  const dir = path.join(env.dataDir, "tasks", `c${p.task.id}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const ac = new AbortController();
  let line: string | undefined;
  const beat = async () => {
    const r = await post(`${base}/beat`, line ? { line } : {}).catch(() => undefined); // the server away a moment: the lease outlives a few
    if (r && r.ok === false) ac.abort();
  };
  const timer = setInterval(() => void beat(), o.beatMs ?? 10_000);
  const paths = ((p.input as { paths?: Record<string, unknown> } | null)?.paths ?? {}) as Record<string, unknown>;
  let release = () => {};
  try {
    // this Mac's other servers' work first, one job at a time (turn.ts); the task stays held and beating meanwhile
    line = TURN_LINE;
    release = await takeTurn({ signal: ac.signal });
    line = undefined;
    const out = await def.run(p.input, {
      dir,
      where: "computer",
      signal: ac.signal,
      beat: (l) => {
        line = l;
      },
      file: async (name) => {
        const here = paths[name];
        if (typeof here === "string" && existsSync(here)) return here;
        const res = await raw(`${base}/file?name=${encodeURIComponent(name)}`, { signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`Could not get the ${name} from the server (${res.status})`);
        const to = path.join(dir, `in-${name}`);
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(to), { signal: ac.signal });
        return to;
      },
      call: async (name, body) => {
        const r = await post(`${base}/call/${encodeURIComponent(name)}`, body);
        if (!r || r.ok !== true) throw new Error(typeof r?.error === "string" ? r.error : `The server refused ${name}`);
        return r.value;
      },
    });
    if (ac.signal.aborted) return "stopped";
    for (const n of out.files ?? []) {
      const f = path.join(dir, n);
      const res = await raw(`${base}/file?name=${encodeURIComponent(n)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(statSync(f).size) },
        body: Readable.toWeb(createReadStream(f)) as ReadableStream,
        signal: ac.signal,
        duplex: "half",
      } as RequestInit);
      if (!res.ok) throw new Error(`The server refused the ${n} (${res.status})`);
    }
    const r = await post(`${base}/done`, { result: out.result ?? null, files: out.files ?? [] });
    return r?.ok === true ? "done" : "failed";
  } catch (e) {
    if (ac.signal.aborted) return "stopped";
    await post(`${base}/fail`, { error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    return "failed";
  } finally {
    release();
    clearInterval(timer);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Folders of tasks this server ran or received that no task holds now (a restart in the middle): removed at boot. */
export async function sweepTasks(): Promise<void> {
  const root = path.join(env.dataDir, "tasks");
  for (const n of await readdir(root).catch(() => [] as string[])) {
    const id = Number(n);
    if (!Number.isSafeInteger(id) || taskOf(id)?.state !== "running") await rm(path.join(root, n), { recursive: true, force: true });
  }
}

/** Moves a made file to where the tool keeps it (a rename, else a copy across disks). */
export async function keep(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    await pipeline(createReadStream(from), createWriteStream(to));
    await rm(from, { force: true });
  }
}
