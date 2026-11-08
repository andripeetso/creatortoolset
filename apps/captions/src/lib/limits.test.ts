import { describe, expect, it } from "vitest";
import type { LimitsIdentity, LimitWindow } from "@contracts/providers";
import { formatDuration, leftOf, limitSections, paceOfShares, resetsIn } from "./limits";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const w = (over: Partial<LimitWindow> & Pick<LimitWindow, "id" | "kind" | "label" | "usedPercent">): LimitWindow => over as LimitWindow;
const id = (label: string, windows: LimitWindow[], over: Partial<LimitsIdentity> = {}): LimitsIdentity => ({
  driver: "claude",
  label,
  state: "ok",
  windows,
  at: NOW,
  device: "mac",
  online: true,
  instances: [`me:${label}`],
  ...over,
});

describe("headline and bar numbers", () => {
  it("the pool headline is the mean of what is left", () => {
    const session = (used: number, reset: number) => w({ id: "five_hour", kind: "session", label: "Session", usedPercent: used, resetsAt: NOW + reset, windowMs: 5 * H });
    const [s] = limitSections([id("a", [session(37, H)]), id("b", [session(28, H)]), id("c", [session(3, H)])], NOW);
    expect(s!.pools[0]!.remaining).toBe(77);
    expect(leftOf(37)).toBe(63);
  });

  it("the refill line is the earliest reset's share of the pool: used / identities, rounded", () => {
    const a = id("work", [w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 37, resetsAt: NOW + H, windowMs: 5 * H })]);
    const b = id("laptop", [w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 28, resetsAt: NOW + 3 * H, windowMs: 5 * H })]);
    const c = id("studio", [w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 3, resetsAt: NOW + 4 * H, windowMs: 5 * H })]);
    const [s] = limitSections([a, b, c], NOW);
    const first = s!.pools[0]!.resets[0]!;
    expect(first.member.identity.label).toBe("work");
    expect(first.restores).toBe(12);
  });

  it("identities are ordered by their first reset in the first window", () => {
    const late = id("late", [w({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 10, resetsAt: NOW + 5 * H, windowMs: 168 * H })]);
    const early = id("early", [w({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 10, resetsAt: NOW + H, windowMs: 168 * H })]);
    const [s] = limitSections([late, early], NOW);
    expect(s!.identities.map((i) => i.label)).toEqual(["early", "late"]);
  });
});

describe("pace", () => {
  it("is ahead above 5 points past the elapsed share, under 5 points below, else on", () => {
    expect(paceOfShares(60, 0.5)).toBe("ahead");
    expect(paceOfShares(40, 0.5)).toBe("under");
    expect(paceOfShares(52, 0.5)).toBe("on");
  });

  it("a Claude weekly window used up makes its session read used, until the weekly resets", () => {
    const session = w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 20, resetsAt: NOW + H, windowMs: 5 * H });
    const weekly = w({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: NOW + 48 * H, windowMs: 168 * H });
    const [s] = limitSections([id("a", [session, weekly])], NOW);
    const sessionPool = s!.pools.find((p) => p.kind === "session")!;
    expect(sessionPool.remaining).toBe(0);
    expect(sessionPool.resets[0]!.at).toBe(NOW + 48 * H); // the weekly comes back after the session
    expect(sessionPool.resets[0]!.restores).toBe(100);
  });
});

describe("countdowns", () => {
  it("formats days, hours and minutes, and the edge words", () => {
    expect(formatDuration(2 * 86_400_000 + 4 * H)).toBe("2d 4h");
    expect(formatDuration(H + 55 * 60_000)).toBe("1h 55m");
    expect(formatDuration(41 * 60_000)).toBe("41m");
    expect(resetsIn(w({ id: "x", kind: "session", label: "S", usedPercent: 0, resetsAt: NOW - 1 }), NOW)).toBe("resets now");
    expect(resetsIn(w({ id: "x", kind: "session", label: "S", usedPercent: 0, resetsAt: NOW + 30_000 }), NOW)).toBe("Resets momentarily");
  });
});
