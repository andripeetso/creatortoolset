import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * One job at a time across this Mac's workers (one per server it is signed in to): a claimed job waits here for the
 * Mac-wide turn, beating meanwhile, and gives it back when it ends. Only when CT_TURN_DIR is set (Worker.swift sets one
 * folder for every server); a Linux worker runs alone and never waits. Fair by ticket: each waiter writes
 * `wait-<ms>-<pid>-<n>`, the lowest one whose process lives takes the turn, held as the file `turn` (its pid inside,
 * made with an exclusive create). A turn or ticket of a process that died is free.
 */
export const TURN_LINE = "Waiting for this Mac's other work";

export interface TurnOptions {
  signal?: AbortSignal;
  /** tests: the folder, the pid this worker writes, how often it looks, and which pids live */
  dir?: string;
  pid?: number;
  everyMs?: number;
  alive?: (pid: number) => boolean;
}

const lives = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

let n = 0;
const ticketOf = (name: string) => name.split("-").slice(1).map(Number); // [ms, pid, n]

/** Waits for the turn; the answer gives it back (once). Throws when `signal` aborts while it waits. */
export async function takeTurn(o: TurnOptions = {}): Promise<() => void> {
  const dir = o.dir ?? process.env.CT_TURN_DIR;
  if (!dir) return () => {};
  const pid = o.pid ?? process.pid;
  const alive = o.alive ?? lives;
  mkdirSync(dir, { recursive: true });
  const mine = `wait-${Date.now()}-${pid}-${n++}`;
  writeFileSync(path.join(dir, mine), "");
  const holder = path.join(dir, "turn");
  try {
    for (;;) {
      o.signal?.throwIfAborted();
      const first = readdirSync(dir)
        .filter((f) => f.startsWith("wait-"))
        .sort((a, b) => {
          const [x, y] = [ticketOf(a), ticketOf(b)];
          return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
        })
        .find((f) => alive(ticketOf(f)[1]!) || void rmSync(path.join(dir, f), { force: true }));
      if (first === mine && grab(holder, pid, alive))
        return () => {
          if (heldBy(holder) === pid) rmSync(holder, { force: true });
        };
      await sleep(o.everyMs ?? 1000, undefined, { signal: o.signal });
    }
  } finally {
    rmSync(path.join(dir, mine), { force: true });
  }
}

const heldBy = (holder: string): number => {
  try {
    return Number(readFileSync(holder, "utf8")) || 0;
  } catch {
    return 0;
  }
};

const emptyLeft = (holder: string): boolean => {
  try {
    return Date.now() - statSync(holder).mtimeMs > 5_000;
  } catch {
    return false;
  }
};

/** Takes the turn when it is free, or held by a process that died. */
function grab(holder: string, pid: number, alive: (pid: number) => boolean): boolean {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(holder, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return true;
    } catch {
      const was = heldBy(holder);
      // empty: just made, its pid not written yet, unless its maker died before writing it
      if (!was && !emptyLeft(holder)) return false;
      if (was && alive(was)) return false;
      rmSync(holder, { force: true });
    }
  }
  return false;
}
