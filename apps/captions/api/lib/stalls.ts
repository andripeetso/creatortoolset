import type { DatabaseSync, StatementSync } from "node:sqlite";
import { cpuProfile, type CpuProfile } from "./cpu-profile";

/**
 * node:sqlite is synchronous: a slow query stops every request on the server until it ends. These name the stall in
 * the server's log: the watchdog says when the process was blocked, the query timer says which SQL did it.
 */

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Logs each statement of `db` that runs longer than `overMs`, with its SQL, and builds each SQL text once: a statement is
 * kept and handed out again (building one again on every call was a third of a busy server's time, 2026-11-26). Safe
 * because every call runs to its end before the next (no iterate). Returns the same database.
 */
export function timeQueries(db: DatabaseSync, overMs = 500, log: (line: string) => void = console.warn): DatabaseSync {
  // the cast keeps node:sqlite's overloads (positional or named parameters); the wrapper passes both through unchanged
  const timed = <F extends (...a: never[]) => unknown>(sql: string, f: F): F =>
    ((...a: Parameters<F>) => {
      const t = performance.now();
      try {
        return f(...a);
      } finally {
        const ms = performance.now() - t;
        if (ms > overMs) log(`[slow query] ${Math.round(ms)} ms: ${oneLine(sql)}`);
      }
    }) as F;
  const prepare = db.prepare.bind(db);
  // shortcut: a text built from a count of "?" makes a statement per count; cleared past 2000, a size no app query nears
  const built = new Map<string, StatementSync>();
  db.prepare = (sql: string): StatementSync => {
    const kept = built.get(sql);
    if (kept) return kept;
    const st = prepare(sql);
    st.all = timed(sql, st.all.bind(st));
    st.get = timed(sql, st.get.bind(st));
    st.run = timed(sql, st.run.bind(st));
    if (built.size >= 2000) built.clear();
    built.set(sql, st);
    return st;
  };
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => timed(sql, exec)(sql);
  return db;
}

/**
 * Logs when the process was blocked for more than `overMs` (a timer that should fire each second fired late). A process
 * kept busy all the time (late by a little, every second) logs where its time goes instead, at most once an hour.
 */
export function startStallWatch(overMs = 2000): void {
  const every = 1000;
  let last = performance.now();
  let lateTurns = 0;
  let turns = 0;
  let profiledAt = -Infinity;
  setInterval(() => {
    const now = performance.now();
    const late = now - last - every;
    if (late > overMs) console.warn(`[stall] the server was blocked for ${(late / 1000).toFixed(1)} s`);
    last = now;
    if (late > 100) lateTurns++;
    if (++turns < 60) return;
    if (lateTurns >= 30 && now - profiledAt > 3_600_000) {
      profiledAt = now;
      const lateOf60 = lateTurns; // counted afresh while the profile runs
      void cpuProfile(10_000, 6, 8)
        .then((p) => console.warn(`[busy] the server was late ${lateOf60} of 60 s; idle ${p.idle}%; where the time went:\n${busyLines(p)}`))
        .catch(() => {});
    }
    turns = lateTurns = 0;
  }, every).unref();
}

/** A profile's busiest paths, one line each: the share, then the function and its callers. */
export const busyLines = (p: CpuProfile): string => p.top.map((t) => `  ${t.share}% ${t.path.join(" < ")}`).join("\n");
