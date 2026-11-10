import { describe, expect, it } from "vitest";
import type { LimitsIdentity, LimitWindow } from "@contracts/providers";
import { countedWindow, formatDuration, leftOf, noticeOf, resetsIn } from "./limits";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const w = (over: Partial<LimitWindow> & Pick<LimitWindow, "id" | "kind" | "label" | "usedPercent">): LimitWindow => over as LimitWindow;
const id = (windows: LimitWindow[], over: Partial<LimitsIdentity> = {}): LimitsIdentity => ({
  driver: "claude",
  label: "default",
  state: "ok",
  windows,
  at: NOW,
  device: "mac",
  online: true,
  instances: ["me:claude_hub"],
  ...over,
});

describe("numbers", () => {
  it("shows the share left, whole percent", () => {
    expect(leftOf(37)).toBe(63);
    expect(leftOf(120)).toBe(0);
  });

  it("formats days, hours and minutes, and the edge words", () => {
    expect(formatDuration(2 * 86_400_000 + 4 * H)).toBe("2d 4h");
    expect(formatDuration(H + 55 * 60_000)).toBe("1h 55m");
    expect(formatDuration(41 * 60_000)).toBe("41m");
    expect(resetsIn(w({ id: "x", kind: "session", label: "S", usedPercent: 0, resetsAt: NOW - 1 }), NOW)).toBe("resets now");
    expect(resetsIn(w({ id: "x", kind: "session", label: "S", usedPercent: 0, resetsAt: NOW + 30_000 }), NOW)).toBe("Resets momentarily");
  });
});

describe("a window as it counts", () => {
  it("a Claude weekly window used up makes its session read used, until the weekly resets", () => {
    const session = w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 20, resetsAt: NOW + H, windowMs: 5 * H });
    const weekly = w({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: NOW + 48 * H, windowMs: 168 * H });
    const counted = countedWindow(id([session, weekly]), session, NOW);
    expect(counted.usedPercent).toBe(100);
    expect(counted.resetsAt).toBe(NOW + 48 * H); // the weekly comes back after the session
  });

  it("a window that is not spent counts as reported", () => {
    const session = w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 20, resetsAt: NOW + H, windowMs: 5 * H });
    expect(countedWindow(id([session]), session, NOW)).toBe(session);
  });
});

describe("the sentence for a login with no reading", () => {
  it("never says 'not signed in': a folder with no sign-in has no plan to read, and the line says why", () => {
    const line = noticeOf(id([], { state: "no_login" })) ?? "";
    expect(line).toBe("This folder has no Claude sign-in, so there is no plan to read.");
    expect(line.toLowerCase()).not.toContain("not signed in");
  });

  it("names a custom endpoint when the Mac reports one for that folder", () => {
    expect(noticeOf(id([], { state: "no_login" }), true)).toContain("custom endpoint");
  });

  it("is null for a reading with windows", () => {
    expect(noticeOf(id([w({ id: "five_hour", kind: "session", label: "Session", usedPercent: 1, resetsAt: NOW + H, windowMs: 5 * H })]))).toBeNull();
  });
});
