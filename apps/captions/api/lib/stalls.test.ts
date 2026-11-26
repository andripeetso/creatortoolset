import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { timeQueries } from "./stalls";

describe("timeQueries", () => {
  it("logs a statement over the limit with its SQL and still returns its rows", () => {
    const lines: string[] = [];
    const db = timeQueries(new DatabaseSync(":memory:"), -1, (l) => lines.push(l));
    db.exec("CREATE TABLE t (n INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(7);
    expect(db.prepare("SELECT n FROM t").all()).toEqual([{ n: 7 }]);
    expect(lines.at(-1)).toMatch(/^\[slow query\] \d+ ms: SELECT n FROM t$/);
    expect(lines).toHaveLength(3);
  });

  it("stays quiet under the limit", () => {
    const lines: string[] = [];
    const db = timeQueries(new DatabaseSync(":memory:"), 60_000, (l) => lines.push(l));
    db.prepare("SELECT 1").get();
    expect(lines).toEqual([]);
  });

  it("builds each SQL text once and hands the same statement out again, with fresh answers each call", () => {
    const db = timeQueries(new DatabaseSync(":memory:"), 60_000, () => {});
    db.exec("CREATE TABLE t (n INTEGER)");
    const add = db.prepare("INSERT INTO t (n) VALUES (?)");
    expect(db.prepare("INSERT INTO t (n) VALUES (?)")).toBe(add);
    add.run(1);
    db.prepare("INSERT INTO t (n) VALUES (?)").run(2);
    expect(db.prepare("SELECT n FROM t ORDER BY n").all()).toEqual([{ n: 1 }, { n: 2 }]);
    expect(db.prepare("SELECT n FROM t WHERE n = ?").get(2)).toEqual({ n: 2 });
    expect(db.prepare("SELECT n FROM t WHERE n = ?").get(1)).toEqual({ n: 1 });
  });
});
