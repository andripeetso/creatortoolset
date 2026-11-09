import { describe, expect, it } from "vitest";
import { mayClaim, score, type WorkerSeen } from "./balance";

const now = 1_000_000;
const mac: WorkerSeen = { host: "mac", at: now, never: [], machine: { cpus: 12, load: 0.2, memGb: 32, freeGb: 16 } };
const pc: WorkerSeen = { host: "pc", at: now, never: [], machine: { cpus: 32, load: 0.2, memGb: 64, freeGb: 32 } };
const on = (weights: Record<string, number> = {}) => ({ on: true, weights });

describe("load balancing", () => {
  it("scores weight × cores × idle CPU × free memory share, and skips a computer that is full", () => {
    expect(score(pc, 50)).toBeCloseTo(50 * 32 * 0.8 * 0.5);
    expect(score({ ...pc, machine: { ...pc.machine!, load: 0.97 } }, 50)).toBe(0);
    expect(score({ ...pc, machine: { ...pc.machine!, freeGb: 2 } }, 50)).toBe(0);
    expect(score({ ...pc, machine: undefined }, 50)).toBe(0);
  });

  it("gives a heavy job to the best free computer, by its preference", () => {
    expect(mayClaim("draft", "mac", [mac, pc], on(), now, 90_000)).toBe(false);
    expect(mayClaim("draft", "pc", [mac, pc], on(), now, 90_000)).toBe(true);
    expect(mayClaim("draft", "mac", [mac, pc], on({ mac: 100, pc: 25 }), now, 90_000)).toBe(true);
    expect(mayClaim("draft", "mac", [mac, { ...pc, busy: true }], on(), now, 90_000)).toBe(true);   // the PC is rendering
    expect(mayClaim("draft", "mac", [mac, { ...pc, at: now - 100_000 }], on(), now, 90_000)).toBe(true);   // offline
    expect(mayClaim("analyze", "mac", [mac, { ...pc, never: ["analyze"] }], on(), now, 90_000)).toBe(true);
    expect(mayClaim("draft", "mac", [mac, pc], on({ mac: 0 }), now, 90_000)).toBe(false);   // Off: not while the PC can take it
    expect(mayClaim("draft", "mac", [mac], on({ mac: 0 }), now, 90_000)).toBe(true);   // Off, and no other computer: it takes it (never queued forever)
    expect(mayClaim("draft", "mac", [mac, { ...pc, busy: true }], on({ mac: 0 }), now, 90_000)).toBe(true);   // the PC is rendering
    expect(mayClaim("draft", "mac", [mac, pc], { on: false, weights: {} }, now, 90_000)).toBe(true);
  });
});
