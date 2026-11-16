import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canMove, IllegalTransition, move, type Moves } from "./transition";

type S = "queued" | "running" | "done";
const MOVES: Moves<S> = { queued: ["running"], running: ["done", "queued"], done: [] };

describe("move", () => {
  it("allows declared moves and staying put", () => {
    expect(move(MOVES, "queued", "running", "job")).toBe("running");
    expect(canMove(MOVES, "done", "done")).toBe(true);
  });
  it("refuses undeclared moves", () => {
    expect(() => move(MOVES, "done", "running", "job")).toThrow(IllegalTransition);
    expect(canMove(MOVES, "queued", "done")).toBe(false);
  });
});

describe("the moves tables in api/", () => {
  it("each is passed to move() or canMove(): a table nothing checks guards nothing, and reads as if it did", () => {
    const api = path.resolve(import.meta.dirname, "..");
    const code = (readdirSync(api, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(path.join(api, f), "utf-8"))
      .join("\n");
    const tables = [...code.matchAll(/const (\w+): Moves</g)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThan(3);
    expect(tables.filter((t) => !new RegExp(`(?:move|canMove)\\(\\s*${t}\\b`).test(code))).toEqual([]);
  });
});
