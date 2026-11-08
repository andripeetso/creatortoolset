import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IllegalTransition, move } from "./lib/transition";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "exports-state-"));
const { EXPORT_MOVES } = await import("./exports");

describe("export job moves", () => {
  it("a job renders once and ends done or error; done never goes back to rendering", () => {
    expect(move(EXPORT_MOVES, "queued", "running", "t")).toBe("running");
    expect(() => move(EXPORT_MOVES, "done", "running", "t")).toThrow(IllegalTransition);
    expect(() => move(EXPORT_MOVES, "error", "done", "t")).toThrow(IllegalTransition);
  });
});
