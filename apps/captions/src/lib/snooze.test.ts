import { describe, expect, it } from "vitest";
import { localInput, snoozeChoices, snoozeLeft } from "./snooze";

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("the times a chat can be put away until", () => {
  it("on a Wednesday morning: an hour, three hours, this evening, tomorrow, next week, soonest first", () => {
    const now = at(2026, 11, 11, 10, 30); // a Wednesday
    const c = snoozeChoices(now);
    expect(c.map((x) => x.label)).toEqual(["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"]);
    expect(c.map((x) => x.until)).toEqual([at(2026, 11, 11, 11, 30), at(2026, 11, 11, 13, 30), at(2026, 11, 11, 18), at(2026, 11, 12, 9), at(2026, 11, 16, 9)]);
    // next week does not say its day, so the weekday stands before its time; the others are times only
    expect(c[4]!.when).toMatch(/^\D+ \d/);
    expect(c[3]!.when).toMatch(/^\d/);
  });

  it("this evening is gone once it is six, and what the hours come to then is sorted with the rest", () => {
    const c = snoozeChoices(at(2026, 11, 11, 18, 0));
    expect(c.map((x) => x.label)).toEqual(["In 1 hour", "In 3 hours", "Tomorrow", "Next week"]);
    // late at night an hour from now is tomorrow: its time says the day
    const late = snoozeChoices(at(2026, 11, 11, 23, 30));
    expect(late[0]).toMatchObject({ label: "In 1 hour", until: at(2026, 11, 12, 0, 30) });
    expect(late[0]!.when).toMatch(/^\D+ \d/);
  });

  it("on a Sunday tomorrow is Monday at nine: next week would be the same minute, so it is offered once", () => {
    const c = snoozeChoices(at(2026, 11, 15, 12)); // a Sunday
    expect(c.filter((x) => x.until === at(2026, 11, 16, 9)).map((x) => x.label)).toEqual(["Tomorrow"]);
  });

  it("on a Monday next week is the Monday after", () => {
    expect(snoozeChoices(at(2026, 11, 16, 8)).at(-1)).toMatchObject({ label: "Next week", until: at(2026, 11, 23, 9) });
  });
});

describe("how long a chat stays away, said short", () => {
  it("minutes, then hours, then days", () => {
    expect(snoozeLeft(12 * 60_000, 0)).toBe("12m");
    expect(snoozeLeft(3 * 3600_000, 0)).toBe("3h");
    expect(snoozeLeft(3 * 86_400_000, 0)).toBe("3d");
    expect(snoozeLeft(0, 5000)).toBe("1m");
  });
});

it("a time as a date-and-time field holds it", () => {
  expect(localInput(at(2026, 3, 5, 7, 9))).toBe("2026-03-05T07:09");
});
