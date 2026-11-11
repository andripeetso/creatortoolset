import { describe, expect, it } from "vitest";
import type { LimitsIdentity, LimitWindow, ProvidersView } from "@contracts/providers";
import { claudeLimitReset, countedWindow, formatDuration, leftOf, noticeOf, planAlert, resetsIn } from "./limits";

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

describe("when a Claude limit comes back", () => {
  const claude = (windows: LimitWindow[], over: Partial<LimitsIdentity> = {}) => id(windows, over);
  const session = (usedPercent: number, resetsAt?: number) => w({ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt });
  const weekly = (usedPercent: number, resetsAt?: number) => w({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent, resetsAt });

  it("says nothing when no window is used up", () => {
    expect(claudeLimitReset([claude([session(62, NOW + H)])], NOW)).toBeNull();
  });

  it("names the reset of the used-up window in Usage's words", () => {
    expect(claudeLimitReset([claude([session(100, NOW + 2 * H + 9 * 60_000)])], NOW)).toBe("resets in 2h 9m");
  });

  it("waits for the latest of the used-up windows", () => {
    expect(claudeLimitReset([claude([session(100, NOW + H), weekly(100, NOW + 3 * 24 * H)])], NOW)).toBe("resets in 3d 0h");
  });

  it("says nothing when a used-up window has no reset time, or only Codex is used up", () => {
    expect(claudeLimitReset([claude([session(100)])], NOW)).toBeNull();
    expect(claudeLimitReset([id([session(100, NOW + H)], { driver: "codex" })], NOW)).toBeNull();
  });
});

describe("the bar's plan line", () => {
  const view = (limits: LimitsIdentity[], checks: ProvidersView["checks"] = {}) => ({ limits, checks }) as unknown as ProvidersView;
  const weekly = (usedPercent: number) => w({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent, resetsAt: NOW + 2 * H });
  const note = "Your Claude plan's weekly limit is reached; it resets 5pm.";

  it("says nothing while every plan has room", () => {
    expect(planAlert(view([id([weekly(50)])]), NOW)).toBeNull();
  });

  it("says a plan that is nearly used up, and one that is used up", () => {
    expect(planAlert(view([id([weekly(88)])]), NOW)?.text).toBe("Claude · Weekly: 12% left");
    expect(planAlert(view([id([weekly(100)])]), NOW)?.text).toBe("Claude · Weekly used up · resets in 2h 0m");
  });

  it("a call that met the limit shows with no reading, and a newer reading wins over it", () => {
    expect(planAlert(view([], { "me:claude_hub": { ok: true, ms: 0, at: NOW - H, note } }), NOW)).toEqual({ text: "Claude weekly limit reached · resets 5pm", full: note });
    expect(planAlert(view([id([weekly(30)])], { "me:claude_hub": { ok: true, ms: 0, at: NOW - H, note } }), NOW)).toBeNull();
  });
});
