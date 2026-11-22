import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { env } from "../lib/env";
import { isOnline, listDevices } from "../lib/devices";
import { libraryDb } from "../library/db";
import { writeJsonAtomic } from "../library/media/run";
import { readMeta, waitingFor } from "../review";
import { readCards } from "./cards/state";
import { nextPass } from "./passes";
import { readStep, type EditMeta } from "./store";

/**
 * The AI Editor's to-do (GET /api/editor/todo, the phone's list and its icon's number): Review videos waiting for the
 * person, edits' cuts sent back with Request changes, the steps running and queued, what waits for their go (a held pass
 * of an edit in passes, a look sheet of cards) and steps that failed in the last 3 days. Review, changes and failed rows
 * the person marked read stay hidden until they change (a new key).
 */

export interface TodoJob {
  /** "j:<edit>:<job id>" */
  key: string;
  edit: string;
  name: string;
  kind: string;
  /** the version's name, "" for a whole-edit step */
  target: string;
  status: "queued" | "running" | "waiting" | "error";
  error?: string;
  /** ms: when it ended, else started (0 when neither is known yet) */
  at: number;
  /** a held pass of an edit in passes: its go queues it */
  hold?: true;
  /** a look sheet: its picture's time (GET /api/editor/:edit/jobs/:job/sheet.jpg) */
  sheet?: { at: number };
}

export interface Todo {
  /** whether one of the person's computers is on (the steps placed on a computer wait for one) */
  worker: { online: boolean; host?: string };
  review: { key: string; asset: string; name: string; project?: string; at: number; ai?: { edit: string; name: string; variant: string } }[];
  changes: { key: string; edit: string; name: string; variant: string; draft: string; asset: string }[];
  running: TodoJob[];
  queued: TodoJob[];
  sheets: TodoJob[];
  failed: TodoJob[];
}

const FAILED_DAYS = 3;
const KEEP_READ = 500;

interface Row {
  id: number;
  version_id: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed" | "needs_key";
  error: string | null;
  started_at: number | null;
  done_at: number | null;
}

const rowsOf = (id: string) =>
  libraryDb().prepare("SELECT id, version_id, kind, state, error, started_at, done_at FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(id) as unknown as Row[];

/** A look sheet that waits for the person: the cards step of a version whose sheet is out and has no answer yet. */
export const sheetOf = (editId: string, variant: string): { at: number } | null => {
  const st = readCards(editId, variant);
  return st?.sheet && !st.go ? { at: st.sheet.at } : null;
};

/**
 * A version of an edit in passes whose cut is in Review and whose next pass waits for the go: the job its go is given on
 * (the version's step that finished last). Nothing while any step of the edit is queued or running (passes.ts
 * passesView), nor for a version with a step that failed: its cut is not the one the pass would start from.
 */
export function heldPasses(e: EditMeta, rows = rowsOf(e.id)): { variant: string; job: number; at: number }[] {
  if (!e.style?.passes || rows.some((r) => r.state === "queued" || r.state === "running")) return [];
  const filed = readStep(e.id, "review") ?? {};
  return Object.keys(filed).flatMap((v) => {
    // one row per step and version, holding its last run: every one done, or the version waits on a failure instead
    const mine = rows.filter((r) => r.version_id === `${e.id}:${v}`);
    const last = mine.every((r) => r.state === "done") ? mine.sort((a, b) => (a.done_at ?? 0) - (b.done_at ?? 0)).at(-1) : undefined;
    return last && !e.marks?.[v]?.trashedAt && nextPass(e, v) ? [{ variant: v, job: last.id, at: last.done_at ?? 0 }] : [];
  });
}

/** Something of the edit waits for the person's go (the edit list's `waits`): a held pass or a look sheet. */
export function waitsGo(e: EditMeta): boolean {
  const rows = rowsOf(e.id);
  return heldPasses(e, rows).length > 0 || rows.some((r) => r.kind === "cards" && r.state === "queued" && !!sheetOf(e.id, r.version_id.slice(e.id.length + 1)));
}

/** Whether a computer of `user` is on (GET /api/editor/worker): the first one's name with it. */
export function workerOf(user: string): Todo["worker"] {
  const on = listDevices((d) => d.owner === user && isOnline(d.id));
  return { online: on.length > 0, ...(on[0] ? { host: on[0].name } : {}) };
}

export async function todoFor(user: string, edits: EditMeta[], read: Set<string>, now = Date.now()): Promise<Todo> {
  const unread = <T extends { key: string }>(list: T[]) => list.filter((x) => !read.has(x.key));
  const ai = new Map<string, { edit: string; name: string; variant: string }>();
  const changes: Todo["changes"] = [];
  const jobs: TodoJob[] = [];
  for (const e of edits) {
    for (const [variant, p] of Object.entries(readStep(e.id, "review") ?? {})) {
      if (e.marks?.[variant]?.trashedAt) continue;
      ai.set(p.assetId, { edit: e.id, name: e.name, variant });
      const m = await readMeta(p.assetId);
      if (m && !m.deletedAt && m.approval.status === "changes")
        changes.push({ key: `c:${p.assetId}:${m.approval.at ?? 0}`, edit: e.id, name: e.name, variant, draft: variant, asset: p.assetId });
    }
    const rows = rowsOf(e.id);
    const held = new Map(heldPasses(e, rows).map((h) => [h.job, h]));
    for (const r of rows) {
      const target = r.version_id.slice(e.id.length + 1);
      const base = { key: `j:${e.id}:${r.id}`, edit: e.id, name: e.name, kind: r.kind, target, at: r.done_at ?? r.started_at ?? 0 };
      const sheet = r.kind === "cards" && r.state === "queued" ? sheetOf(e.id, target) : null;
      if (sheet) jobs.push({ ...base, status: "waiting", sheet });
      else if (held.has(r.id)) jobs.push({ ...base, kind: nextPass(e, target)!, status: "waiting", hold: true });
      else if (r.state === "queued" || r.state === "running") jobs.push({ ...base, status: r.state });
      // a step the person stopped is not a failure that waits on them
      else if ((r.state === "failed" && r.error !== "Stopped") || r.state === "needs_key") jobs.push({ ...base, status: "error", ...(r.error ? { error: r.error } : {}) });
    }
  }
  const recent = now - FAILED_DAYS * 24 * 3600_000;
  return {
    worker: workerOf(user),
    review: unread((await waitingFor(user)).map((r) => ({ key: `r:${r.asset}:${r.at}`, ...r, ...(ai.has(r.asset) ? { ai: ai.get(r.asset)! } : {}) }))),
    changes: unread(changes),
    running: jobs.filter((j) => j.status === "running"),
    queued: jobs.filter((j) => j.status === "queued"),
    sheets: jobs.filter((j) => j.status === "waiting"),
    failed: unread(jobs.filter((j) => j.status === "error" && j.at > recent)).sort((a, b) => b.at - a.at).slice(0, 5),
  };
}

/** How many things wait on the person: the number on the app's icon. */
export const waitingCount = (t: Todo) => t.review.length + t.changes.length + t.sheets.length + t.failed.length;

const readFileOf = () => path.join(env.dataDir, "editor", "todo-read.json");
const allRead = async (): Promise<Record<string, string[]>> => JSON.parse(await readFile(readFileOf(), "utf8").catch(() => "{}")) as Record<string, string[]>;
let chain: Promise<unknown> = Promise.resolve();

/** The to-do keys `user` marked read. */
export const readKeys = async (user: string): Promise<Set<string>> => new Set((await allRead())[user] ?? []);

/** Marks to-do rows read for `user` (✓ on a row, Mark all read); their newest KEEP_READ keys are kept, older rows have left the list. */
export function markRead(user: string, keys: string[]): Promise<void> {
  const run = chain.then(async () => {
    const all = await allRead();
    all[user] = [...new Set([...(all[user] ?? []), ...keys])].slice(-KEEP_READ);
    await mkdir(path.dirname(readFileOf()), { recursive: true });
    await writeJsonAtomic(readFileOf(), all);
  });
  chain = run.catch(() => undefined);
  return run;
}
