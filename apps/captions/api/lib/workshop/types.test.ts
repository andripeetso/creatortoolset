import { describe, expect, it } from "vitest";
import { IllegalTransition } from "../transition";
import { SESSION_FINISHED, SESSION_MOVES, SESSION_STATUSES, SESSION_WAITING, setSessionStatus, type SessionStatus } from "./types";

describe("session status moves", () => {
  it("has a row for every status and nothing else", () => {
    expect(Object.keys(SESSION_MOVES).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it("a shelved session only goes back to Writing", () => {
    const m: { status?: SessionStatus; statusAt?: number } = { status: "shelved" };
    expect(() => setSessionStatus(m, "ready", "test")).toThrow(IllegalTransition);
    expect(m.status).toBe("shelved");
    expect(setSessionStatus(m, "ready", "test", { skipIllegal: true })).toBe(false);
    expect(m.status).toBe("shelved");
    setSessionStatus(m, "writing", "test");
    expect(m.status).toBe("writing");
  });

  it("a missing status counts as Idea and the stamp is the one given", () => {
    const m: { status?: SessionStatus; statusAt?: number } = {};
    setSessionStatus(m, "production", "test", { at: 5 });
    expect(m).toEqual({ status: "production", statusAt: 5 });
  });

  it("every filmed-or-later status counts as finished", () => {
    for (const s of SESSION_WAITING) expect(SESSION_FINISHED).toContain(s);
  });
});
