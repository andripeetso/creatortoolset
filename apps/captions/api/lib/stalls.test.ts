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
});
