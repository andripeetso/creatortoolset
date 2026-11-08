import { describe, expect, it } from "vitest";
import { IllegalTransition, canMove, move } from "../transition";
import { JOB_STATUS_MOVES, POST_STATUS_MOVES } from "./types";

describe("Analyzer post status moves", () => {
  it("lets a run finish, fail, or be queued again", () => {
    expect(move(POST_STATUS_MOVES, "processing", "ready", "post")).toBe("ready");
    expect(move(POST_STATUS_MOVES, "processing", "error", "post")).toBe("error");
    expect(move(POST_STATUS_MOVES, "error", "processing", "post")).toBe("processing");
  });

  it("refuses a finished post going back to error without a run", () => {
    expect(() => move(POST_STATUS_MOVES, "ready", "error", "post")).toThrow(IllegalTransition);
    expect(canMove(POST_STATUS_MOVES, "ready", "error")).toBe(false);
  });
});

describe("Analyzer job status moves", () => {
  it("a running job ends in done, skipped or error; a failed one can be retried", () => {
    expect(canMove(JOB_STATUS_MOVES, "running", "done")).toBe(true);
    expect(canMove(JOB_STATUS_MOVES, "running", "error")).toBe(true);
    expect(canMove(JOB_STATUS_MOVES, "error", "pending")).toBe(true);
  });

  it("a done job cannot jump to error without running", () => {
    expect(canMove(JOB_STATUS_MOVES, "done", "error")).toBe(false);
  });
});
