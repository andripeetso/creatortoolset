import { describe, expect, it } from "vitest";
import { describeSchedule, normalizeSchedule, nextRunAfter, scheduleError, validTimezone } from "../contracts/automations";

const at = (iso: string) => Date.parse(iso);
const H = 3_600_000;

describe("next run: wall-clock times in the automation's zone", () => {
  it("daily 09:00 Berlin keeps its wall clock across the March switch (CET to CEST)", () => {
    const daily = { kind: "daily", at: "09:00" } as const;
    // 09:00 CET on the 28th is 08:00 UTC; the 29th's 09:00 is already CEST, 07:00 UTC (a 23-hour gap in UTC)
    const next = nextRunAfter(daily, "Europe/Berlin", at("2026-03-28T08:00:00Z"));
    expect(next).toBe(at("2026-03-29T07:00:00Z"));
    expect(nextRunAfter(daily, "Europe/Berlin", next)).toBe(at("2026-03-30T07:00:00Z"));
  });

  it("daily 09:00 Berlin across the October switch (CEST back to CET): 25 hours, same wall clock", () => {
    const daily = { kind: "daily", at: "09:00" } as const;
    // the run at 09:00 CEST on the 24th is 07:00 UTC; it is strictly after that instant, so the next is the 25th's 09:00 CET
    const next = nextRunAfter(daily, "Europe/Berlin", at("2026-10-24T07:00:00Z"));
    expect(next).toBe(at("2026-10-25T08:00:00Z"));
  });

  it("a time that doesn't exist on the spring-forward day (02:30 Berlin) gives a sane instant, and the day after is back on 02:30", () => {
    const night = { kind: "daily", at: "02:30" } as const;
    // 02:30 CET on the 28th is 01:30 UTC; on the 29th 02:30 never happens: the run lands at 03:30 CEST (01:30 UTC)
    const jump = nextRunAfter(night, "Europe/Berlin", at("2026-03-28T01:30:00Z"));
    expect(jump).toBe(at("2026-03-29T01:30:00Z"));
    // the 30th is CEST again: 02:30 CEST is 00:30 UTC, no drift from the gap
    expect(nextRunAfter(night, "Europe/Berlin", jump)).toBe(at("2026-03-30T00:30:00Z"));
  });

  it("a run at the same instant is never its own next run (no double run)", () => {
    const daily = { kind: "daily", at: "09:00" } as const;
    const ran = at("2026-11-08T08:00:00Z");
    const next = nextRunAfter(daily, "Europe/Berlin", ran);
    expect(next).toBeGreaterThan(ran);
    expect(next).toBe(at("2026-11-09T08:00:00Z"));
  });

  it("weekly Monday 09:00 Berlin counts from a Saturday to the coming Monday", () => {
    expect(new Date("2026-11-09T00:00:00Z").getUTCDay()).toBe(1); // the test's own calendar check
    const monday = { kind: "weekly", weekday: 1, at: "09:00" } as const;
    expect(nextRunAfter(monday, "Europe/Berlin", at("2026-11-07T12:00:00Z"))).toBe(at("2026-11-09T08:00:00Z"));
  });

  it("a zone with no DST (Tokyo) is a fixed offset; the exact run instant rolls to the next day", () => {
    const daily = { kind: "daily", at: "09:00" } as const;
    expect(nextRunAfter(daily, "Asia/Tokyo", at("2026-11-07T00:00:00Z"))).toBe(at("2026-11-08T00:00:00Z"));
  });

  it("a fresh daily automation's first run is in the future, not now", () => {
    const daily = { kind: "daily", at: "09:00" } as const;
    const created = at("2026-11-07T06:00:00Z"); // 07:00 in Berlin
    expect(nextRunAfter(daily, "Europe/Berlin", created)).toBe(at("2026-11-07T08:00:00Z"));
  });

  it("every N hours counts from the last run", () => {
    expect(nextRunAfter({ kind: "hours", every: 6 }, "UTC", at("2026-11-07T10:00:00Z"))).toBe(at("2026-11-07T10:00:00Z") + 6 * H);
  });
});

describe("validation", () => {
  it("accepts IANA zones and refuses the rest", () => {
    expect(validTimezone("Europe/Berlin")).toBe(true);
    expect(validTimezone("UTC")).toBe(true);
    expect(validTimezone("Mars/Base")).toBe(false);
    expect(validTimezone("")).toBe(false);
  });

  it("checks each schedule kind's own fields", () => {
    expect(scheduleError({ kind: "daily", at: "09:00" })).toBeNull();
    expect(scheduleError({ kind: "daily", at: "25:00" })).not.toBeNull();
    expect(scheduleError({ kind: "daily", at: "9:00" })).not.toBeNull();
    expect(scheduleError({ kind: "weekly", weekday: 7, at: "09:00" })).not.toBeNull();
    expect(scheduleError({ kind: "weekly", weekday: 0, at: "09:00" })).toBeNull();
    expect(scheduleError({ kind: "hours", every: 0 })).not.toBeNull();
    expect(scheduleError({ kind: "hours", every: 169 })).not.toBeNull();
    expect(scheduleError({ kind: "hours", every: 1.5 })).not.toBeNull();
    expect(scheduleError({ kind: "hours", every: 168 })).toBeNull();
    expect(scheduleError({ kind: "monthly", at: "09:00" })).not.toBeNull();
    expect(scheduleError(null)).not.toBeNull();
  });

  it("keeps only the fields its kind uses, and says it in words", () => {
    expect(normalizeSchedule({ kind: "daily", at: "09:00", weekday: 3, every: 2 })).toEqual({ kind: "daily", at: "09:00" });
    expect(describeSchedule({ kind: "weekly", weekday: 1, at: "09:00" }, "Europe/Berlin")).toBe("Every Monday at 09:00 (Europe/Berlin)");
    expect(describeSchedule({ kind: "hours", every: 6 }, "UTC")).toBe("Every 6 hours");
  });
});
