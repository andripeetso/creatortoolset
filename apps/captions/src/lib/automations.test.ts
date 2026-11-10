import { describe, expect, it } from "vitest";
import { blankDraft, draftBody, draftError, draftOf, scheduleLabel, statusOf, type AutomationDraft, type AutomationView } from "./automations";

const ai = { instance: "claude", model: "claude-opus-5-5", effort: "high" as const };
const base: AutomationDraft = { ...blankDraft(0), name: " Hooks ", prompt: " draft three hooks ", ai };

describe("scheduled task form", () => {
  it("sends what the form shows: trimmed, the zone, all seven days as every day", () => {
    expect(draftBody(base, "Europe/Berlin")).toEqual({
      name: "Hooks",
      prompt: "draft three hooks",
      schedule: { kind: "fixed", at: "09:00" },
      timezone: "Europe/Berlin",
      enabled: true,
      destination: "new_chat",
      ai,
      project: null,
    });
    expect(draftBody({ ...base, weekdays: [5, 1] }, "UTC").schedule).toEqual({ kind: "fixed", at: "09:00", weekdays: [1, 5] });
    expect(draftBody({ ...base, mode: "interval", every: 30, unit: "minutes" }, "UTC").schedule).toEqual({ kind: "interval", everyMinutes: 30 });
    expect(draftBody({ ...base, mode: "interval", every: 2, unit: "hours" }, "UTC").schedule).toEqual({ kind: "interval", everyMinutes: 120 });
  });

  it("reads a saved task back into the form", () => {
    const d = draftOf({ id: "x", name: "A", prompt: "p", enabled: false, destination: "fresh", timezone: "UTC", createdAt: 0, ai, schedule: { kind: "interval", everyMinutes: 180 } });
    expect(d).toMatchObject({ mode: "interval", every: 3, unit: "hours", enabled: false, destination: "fresh", ai });
  });

  it("says what is missing before it sends", () => {
    expect(draftError({ ...base, prompt: " " })).toContain("what the task should do");
    expect(draftError({ ...base, ai: null })).toContain("AI");
    expect(draftError({ ...base, weekdays: [] })).toContain("one day");
    expect(draftError({ ...base, mode: "once", runAt: "2020-01-01T09:00" })).toContain("passed");
    expect(draftError(base)).toBeNull();
  });

  it("names the schedule in plain words", () => {
    expect(scheduleLabel({ kind: "fixed", at: "09:00" }, "UTC")).toBe("Daily at 09:00");
    expect(scheduleLabel({ kind: "fixed", at: "09:00", weekdays: [1, 2, 3, 4, 5] }, "UTC")).toBe("Weekdays at 09:00");
    expect(scheduleLabel({ kind: "fixed", at: "18:30", weekdays: [0, 1, 3] }, "UTC")).toBe("Mo, We, Su at 18:30");
    expect(scheduleLabel({ kind: "interval", everyMinutes: 30 }, "UTC")).toBe("Every 30 min");
    expect(scheduleLabel({ kind: "interval", everyMinutes: 120 }, "UTC")).toBe("Every 2 hours");
    expect(scheduleLabel({ kind: "once", runAt: Date.parse("2026-11-12T14:00:00Z") }, "UTC")).toBe("Once, 12 Nov 2026, 14:00");
  });
});

describe("a task row's status", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const task = (over: Partial<AutomationView>) =>
    ({ id: "t1", name: "Daily caption check", schedule: { kind: "fixed", at: "09:00", weekdays: [1, 2, 3, 4, 5] }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: true, running: false, nextRun: NOW + 3 * H, ...over }) as AutomationView;

  it("says when it runs and when next, and nothing more when the last run was fine", () => {
    expect(statusOf(task({ lastResult: { status: "done", at: NOW - H, text: "All good" } }), NOW, null)).toEqual({ line: "Weekdays at 09:00 · Next run in 3 h" });
    expect(statusOf(task({ enabled: false }), NOW, null).line).toBe("Weekdays at 09:00 · Paused");
    expect(statusOf(task({ timezone: "Pacific/Chatham" }), NOW, null).line).toBe("Weekdays at 09:00 (Pacific/Chatham) · Next run in 3 h");
  });

  it("a failed run is red, and for a usage limit says when it comes back", () => {
    expect(statusOf(task({ lastResult: { status: "error", at: NOW - 2 * H, text: "Claude hit its usage limit." } }), NOW, "resets in 2h 9m").problem).toEqual({
      tone: "broken",
      text: "Failed 2 h ago: Claude hit its usage limit. · resets in 2h 9m",
    });
  });

  it("a skipped run is amber and says why", () => {
    expect(statusOf(task({ lastResult: { status: "skipped", at: NOW - H, text: "Missed the 09:00 run (Mac Studio is offline)." } }), NOW, null).problem).toEqual({
      tone: "attention",
      text: "Skipped 1 h ago: Missed the 09:00 run (Mac Studio is offline).",
    });
  });
});
