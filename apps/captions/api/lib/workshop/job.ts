import { AsyncLocalStorage } from "node:async_hooks";
import { announce } from "../sync";

/**
 * Background work (a reply, a review, research, a draft, a knowledge read) saves without an HTTP write, so nothing
 * announces it. Run it inside inJob with the accounts that look at it (the record's owner and the one who asked):
 * each save inside it (saved(), called by the Workshop's file writes) tells their open tabs, at most every THROTTLE ms
 * and once more the moment the work ends. Saves outside a job (a request's own write) are announced by the request.
 */
const job = new AsyncLocalStorage<string[]>();
export const THROTTLE = 1000;
const last = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function fire(owner: string) {
  const t = timers.get(owner);
  if (t) clearTimeout(t);
  timers.delete(owner);
  last.set(owner, Date.now());
  announce(owner, "workshop");
}

export function inJob<T>(owners: Array<string | undefined>, fn: () => Promise<T>): Promise<T> {
  const list = [...new Set(owners.filter((o): o is string => !!o))];
  // the end: what it saved last shows at once, not a throttle later
  return job.run(list, fn).finally(() => list.forEach((o) => timers.has(o) && fire(o)));
}

/** A save happened: inside a job, its accounts hear about it (leading and trailing, THROTTLE apart). */
export function saved(): void {
  for (const owner of job.getStore() ?? []) {
    if (timers.has(owner)) continue;
    const wait = THROTTLE - (Date.now() - (last.get(owner) ?? 0));
    if (wait <= 0) fire(owner);
    else {
      const t = setTimeout(() => fire(owner), wait);
      t.unref?.();
      timers.set(owner, t);
    }
  }
}
