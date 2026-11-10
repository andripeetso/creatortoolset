import { AsyncLocalStorage } from "node:async_hooks";
import { announce } from "../sync";

/**
 * Background work (a reply, a review, research, a draft, a knowledge read) saves without an HTTP write, so nothing
 * announces it. Run it inside inJob with the accounts that look at it (the record's owner and the one who asked):
 * each save inside it (saved(), called by the Workshop's file writes) tells their open tabs, at most every THROTTLE ms,
 * and once more the moment the work ends if it saved anything. Saves outside a job (a request's own write) are
 * announced by the request. Callbacks someone else calls (a Mac's answer arrives on the Mac's own request) are wrapped
 * in keepJob where they are made, so their saves still count.
 * A job about one session (`session`) announces only that session ("workshop/s/<id>": its own page refetches, not every
 * Workshop list) while it runs, and the whole Workshop once at the end (lists, the summary, Home's badges).
 */
type Job = { owners: string[]; saved: boolean; session?: string };
const job = new AsyncLocalStorage<Job>();
export const THROTTLE = 1000;
const last = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const topicOf = (j: Job) => (j.session ? `workshop/s/${j.session}` : "workshop");

function fire(owner: string, j: Job, end = false) {
  const topic = topicOf(j);
  const id = `${owner}|${topic}`;
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  last.set(id, Date.now());
  announce(owner, topic);
  if (end && j.session) announce(owner, "workshop");
}

export function inJob<T>(owners: Array<string | undefined>, fn: () => Promise<T>, session?: string): Promise<T> {
  const j: Job = { owners: [...new Set(owners.filter((o): o is string => !!o))], saved: false, session };
  // the end: what it saved last shows at once, not a throttle later
  return job.run(j, fn).finally(() => j.saved && j.owners.forEach((o) => fire(o, j, true)));
}

/** A function, or an object of them, that keeps the job it was made in when someone else calls it. */
export function keepJob<T extends object>(x: T): T {
  const j = job.getStore();
  if (!j) return x;
  const wrap = (f: (...a: unknown[]) => unknown) => (...a: unknown[]) => job.run(j, () => f(...a));
  if (typeof x === "function") return wrap(x as (...a: unknown[]) => unknown) as T;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "function" ? wrap(v) : v])) as T;
}

/** A save happened: inside a job, its accounts hear about it (leading and trailing, THROTTLE apart). */
export function saved(): void {
  const j = job.getStore();
  if (!j) return;
  j.saved = true;
  for (const owner of j.owners) {
    const id = `${owner}|${topicOf(j)}`;
    if (timers.has(id)) continue;
    const wait = THROTTLE - (Date.now() - (last.get(id) ?? 0));
    if (wait <= 0) fire(owner, j);
    else {
      const t = setTimeout(() => fire(owner, j), wait);
      t.unref?.();
      timers.set(id, t);
    }
  }
}
