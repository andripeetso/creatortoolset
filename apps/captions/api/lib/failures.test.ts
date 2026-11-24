import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "failures-"));
const { failuresOf, noteFailure } = await import("./failures");
const NOW = 1_800_000_000_000;

describe("recent failures", () => {
  it("counts a repeat, not the same work told twice, and keeps 20 per account", () => {
    noteFailure("tiny", "work", "Export", { error: "Encoder stopped", ref: "export:1" }, NOW);
    noteFailure("tiny", "work", "Export", { error: "Encoder stopped", ref: "export:1" }, NOW);
    noteFailure("tiny", "work", "Export", { error: "Encoder stopped", ref: "export:2" }, NOW);
    expect(failuresOf("tiny", "work", NOW)).toEqual([{ minutesAgo: 0, what: "Export", error: "Encoder stopped", count: 2 }]);
    for (let n = 0; n < 25; n++) noteFailure("tiny", "request", `GET /api/x/${n}`, { status: 500 }, NOW + n);
    const kept = failuresOf("tiny", "request", NOW + 30);
    expect(kept).toHaveLength(20);
    expect(kept.at(-1)!.what).toBe("GET /api/x/24");
    expect(failuresOf("tiny", "work", NOW)).toHaveLength(1);
  });

  it("drops what is older than 14 days and is kept on disk", async () => {
    expect(failuresOf("tiny", "work", NOW + 15 * 24 * 60 * 60_000)).toEqual([]);
    await vi.waitFor(() => expect(existsSync(path.join(process.env.DATA_DIR!, "recent-failures.json"))).toBe(true), { timeout: 3000 });
    expect(readFileSync(path.join(process.env.DATA_DIR!, "recent-failures.json"), "utf-8")).toContain("Encoder stopped");
  });

  it("keeps the newest 5000 of the whole server's", () => {
    for (let n = 0; n < 5100; n++) noteFailure(`u${n}`, "request", "GET /api/x", { status: 500 }, NOW + 100 + n);
    expect(failuresOf("u0", "request", NOW + 6000)).toEqual([]);
    expect(failuresOf("u5099", "request", NOW + 6000)).toHaveLength(1);
  });
});
