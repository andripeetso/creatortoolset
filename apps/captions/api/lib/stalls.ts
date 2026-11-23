import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * node:sqlite is synchronous: a slow query stops every request on the server until it ends. These name the stall in
 * the server's log: the watchdog says when the process was blocked, the query timer says which SQL did it.
 */

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 300);

/** Logs each statement of `db` that runs longer than `overMs`, with its SQL. Returns the same database. */
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
  db.prepare = (sql: string): StatementSync => {
    const st = prepare(sql);
    st.all = timed(sql, st.all.bind(st));
    st.get = timed(sql, st.get.bind(st));
    st.run = timed(sql, st.run.bind(st));
    return st;
  };
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => timed(sql, exec)(sql);
  return db;
}

/** Logs when the process was blocked for more than `overMs` (a timer that should fire each second fired late). */
export function startStallWatch(overMs = 2000): void {
  const every = 1000;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - every;
    if (late > overMs) console.warn(`[stall] the server was blocked for ${(late / 1000).toFixed(1)} s`);
    last = now;
  }, every).unref();
}
