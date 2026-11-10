import { describe, expect, it } from "vitest";
import { cadenceOf, draftBody, draftOf, type AutomationDraft } from "./automations";

const base: AutomationDraft = { name: " Hooks ", prompt: " draft three hooks ", kind: "daily", at: "09:00", weekday: 1, every: 6 };

describe("automation form body", () => {
  it("sends the schedule the form shows, trimmed, with the zone", () => {
    expect(draftBody(base, "Europe/Berlin")).toEqual({
      name: "Hooks",
      prompt: "draft three hooks",
      schedule: { kind: "daily", at: "09:00" },
      timezone: "Europe/Berlin",
    });
    expect(draftBody({ ...base, kind: "weekly", weekday: 1 }, "UTC").schedule).toEqual({ kind: "weekly", weekday: 1, at: "09:00" });
    expect(draftBody({ ...base, kind: "hours", every: 3 }, "UTC").schedule).toEqual({ kind: "hours", every: 3 });
  });

  it("reads an existing automation back into the form", () => {
    const d = draftOf({ id: "x", name: "A", prompt: "p", enabled: true, timezone: "UTC", createdAt: 0, schedule: { kind: "weekly", weekday: 5, at: "18:30" } });
    expect(d).toMatchObject({ kind: "weekly", weekday: 5, at: "18:30" });
  });

  it("names the cadence in plain words", () => {
    expect(cadenceOf({ kind: "weekly", weekday: 1, at: "09:00" })).toBe("Every Monday 09:00");
    expect(cadenceOf({ kind: "daily", at: "18:30" })).toBe("Every day 18:30");
    expect(cadenceOf({ kind: "hours", every: 6 })).toBe("Every 6 hours");
  });
});
