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
