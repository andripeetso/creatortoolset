import { describe, expect, it } from "vitest";
import { allowsLibrary, claimsFresh, mayClaim, score, takesOriginals, type WorkerSeen } from "./balance";

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
    expect(mayClaim("draft", "mac", [mac], on({ mac: 0 }), now, 90_000)).toBe(false);   // Off is off, even with no other computer
    expect(mayClaim("draft", "mac", [mac, { ...pc, busy: true }], on({ mac: 0 }), now, 90_000)).toBe(false);   // nor while the PC is rendering
    expect(mayClaim("draft", "mac", [], on(), now, 90_000)).toBe(true);   // nobody reports a load yet: the one asking takes it
    expect(mayClaim("draft", "mac", [mac, pc], { on: false, weights: {} }, now, 90_000)).toBe(true);
  });

  it("gives the job to the computer set to Prefer over a stronger one set to Normal, and an Off one never blocks it", () => {
    const twin = { ...mac, host: "pc" }; // the same machine, set to Normal
    expect(mayClaim("proxy", "pc", [mac, twin], on({ mac: 100, pc: 50 }), now, 90_000)).toBe(false);
    expect(mayClaim("proxy", "mac", [mac, twin], on({ mac: 100, pc: 50 }), now, 90_000)).toBe(true);
    expect(mayClaim("proxy", "pc", [mac, pc], on({ mac: 0 }), now, 90_000)).toBe(true);
  });

  it("reads which libraries and originals a computer takes, every library and a Mac's originals unless set", () => {
    const b = { on: true, weights: {}, libraries: { pc: ["lib-a"] }, originals: { mac: false } };
    expect(allowsLibrary(b, "pc", "lib-a")).toBe(true);
    expect(allowsLibrary(b, "pc", "lib-b")).toBe(false);
    expect(allowsLibrary(b, "mac", "lib-b")).toBe(true);
    expect(takesOriginals(b, { id: "mac", report: { at: 0, drivers: [], homes: [], machine: { os: "mac", cpus: 1, memGb: 1 } } })).toBe(false);
    expect(takesOriginals({ on: true, weights: {} }, { id: "m2", report: { at: 0, drivers: [], homes: [], machine: { os: "mac", cpus: 1, memGb: 1 } } })).toBe(true);
    expect(takesOriginals({ on: true, weights: {} }, { id: "pc", report: { at: 0, drivers: [], homes: [], machine: { os: "linux", cpus: 1, memGb: 1 } } })).toBe(false);
  });

  it("counts a computer as asking for work only while its last claim is under two minutes old", () => {
    expect(claimsFresh({ work: { v: 1, steps: [], at: now - 60_000 } }, now)).toBe(true);
    expect(claimsFresh({ work: { v: 1, steps: [], at: now - 121_000 } }, now)).toBe(false);
    expect(claimsFresh({ work: { v: 1, steps: [] } }, now)).toBe(false);
  });
});
