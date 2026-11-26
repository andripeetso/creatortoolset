import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env";
import { scrub } from "./telemetry";

/**
 * What failed lately, per account, for Report a problem (api/bug-report.ts): its requests the server answered with an
 * error, and its work that ended failed (an export, a Video Note, an edit, the Content Workshop's writer, a reply). Kept
 * on disk, so a restart (often the first thing tried) keeps them; 20 of each kind per account, none older than 14 days.
 */
export type FailureKind = "request" | "work";
type Failure = { at: number; user: string; kind: FailureKind; what: string; status?: number; error?: string; ref?: string; count: number };

const KEEP = 20;
const TOTAL = 5000;
const MAX_AGE = 14 * 24 * 60 * 60_000;
const file = () => path.join(env.dataDir, "recent-failures.json");

let list: Failure[] | null = null;
const all = (): Failure[] => {
  if (list) return list;
  try {
    const read = JSON.parse(readFileSync(file(), "utf-8")) as unknown;
    list = Array.isArray(read) ? (read as Failure[]) : [];
  } catch {
    list = []; // none yet, or unreadable: starts again
  }
  return list;
};

let timer: NodeJS.Timeout | undefined;
const saveSoon = () => {
  timer ??= setTimeout(() => {
    timer = undefined;
    try {
      mkdirSync(env.dataDir, { recursive: true });
      writeFileSync(`${file()}.tmp`, JSON.stringify(all()));
      renameSync(`${file()}.tmp`, file());
    } catch {
      // a full disk: the list stays in memory
    }
  }, 1000);
  timer.unref?.();
};

/**
 * One failure. A repeat (the same what, status and error) is counted on the one kept; the same work (`ref`) failing
 * with the same error again is the same failure told twice, not counted.
 */
export function noteFailure(user: string, kind: FailureKind, what: string, f: { status?: number; error?: string; ref?: string } = {}, now = Date.now()): void {
  const rows = all();
  const error = f.error ? scrub(f.error.replace(/\s+/g, " ").trim()).slice(0, 300) || undefined : undefined;
  const at = rows.findIndex((r) => r.user === user && r.kind === kind && r.what === what && r.status === f.status && r.error === error);
  if (at >= 0) {
    const [same] = rows.splice(at, 1);
    rows.push({ ...same!, at: now, count: same!.count + (f.ref && same!.ref === f.ref ? 0 : 1), ref: f.ref });
    if (!(f.ref && same!.ref === f.ref)) count({ kind, what, status: f.status, error });
  } else {
    rows.push({ at: now, user, kind, what: what.slice(0, 200), ...(f.status ? { status: f.status } : {}), ...(error ? { error } : {}), ...(f.ref ? { ref: f.ref } : {}), count: 1 });
    count({ kind, what, status: f.status, error });
  }
  const mine = rows.filter((r) => r.user === user && r.kind === kind);
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - KEEP)));
  // the newest TOTAL of the whole server's: many accounts (Cloud) never make the file big or slow to write
  list = rows.filter((r) => !drop.has(r) && now - r.at < MAX_AGE).slice(-TOTAL);
  saveSoon();
}

/* ---- the counts a check-in carries (lib/telemetry.ts): the whole server's, with no account ---- */

export type FailureCount = { kind: FailureKind; what: string; status?: number; error?: string; count: number };
const UNSENT_MAX = 50;
const SEND_MAX = 15;
let unsent = new Map<string, FailureCount>();

// A request's path keeps its plain words only: an id or a name in it would split one failure into many, or be a person's.
const shapeOf = (what: string) => what.replace(/\/[^/\s]+/g, (seg) => (/^\/[a-z][a-z-]*$/.test(seg) ? seg : "/:id")).slice(0, 100);

function count(f: Omit<FailureCount, "count">, n = 1): void {
  const row = { kind: f.kind, what: shapeOf(f.what), ...(f.status ? { status: f.status } : {}), ...(f.error ? { error: f.error.slice(0, 160) } : {}) };
  const key = `${row.kind}\n${row.what}\n${row.status ?? ""}\n${row.error ?? ""}`;
  const have = unsent.get(key);
  if (have) have.count += n;
  else if (unsent.size < UNSENT_MAX) unsent.set(key, { ...row, count: n });
}

/** The failures since the last check-in, most first, and starts again from none. */
export function takeFailureCounts(): FailureCount[] {
  const out = [...unsent.values()].sort((a, b) => b.count - a.count).slice(0, SEND_MAX);
  unsent = new Map();
  return out;
}

/** A check-in that did not go: its counts wait for the next one. */
export const putBackFailureCounts = (rows: FailureCount[]) => rows.forEach((r) => count(r, r.count));

/** An account's failures of one kind, oldest first, as a report carries them. */
export const failuresOf = (user: string, kind: FailureKind, now = Date.now()) =>
  all()
    .filter((r) => r.user === user && r.kind === kind && now - r.at < MAX_AGE)
    .map((r) => ({ minutesAgo: Math.round((now - r.at) / 60_000), what: r.what, ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}), ...(r.count > 1 ? { count: r.count } : {}) }));
