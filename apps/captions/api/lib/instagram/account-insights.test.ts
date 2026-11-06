import { describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  insightDayCovered,
  mergeAccountStats,
  mergeInsightDays,
  nextGraphDaily,
  type GraphDaily,
  type InsightDay,
  type MineAccountStats,
} from "./account-insights";

const end = (iso: string) => Date.parse(iso);

describe("insightDayCovered", () => {
  it("labels a value with the Pacific day that ends at its end_time", () => {
    // summer time: days end at 07:00 UTC
    expect(insightDayCovered(end("2026-09-23T07:00:00Z"))).toBe("2026-09-22");
    // winter time: days end at 08:00 UTC
    expect(insightDayCovered(end("2026-01-15T08:00:00Z"))).toBe("2026-01-14");
  });

  it("holds across the clock changes", () => {
    // 2026-11-01 is 25 hours long in Los Angeles, 2026-03-08 is 23
    expect(insightDayCovered(end("2026-11-01T07:00:00Z"))).toBe("2026-10-31");
    expect(insightDayCovered(end("2026-11-02T08:00:00Z"))).toBe("2026-11-01");
    expect(insightDayCovered(end("2026-03-08T08:00:00Z"))).toBe("2026-03-07");
    expect(insightDayCovered(end("2026-03-09T07:00:00Z"))).toBe("2026-03-08");
  });
});

describe("mergeInsightDays", () => {
  const row = (date: string, extra: Partial<InsightDay> = {}): InsightDay => ({
    date,
    endTime: end(`${date}T00:00:00Z`) + 86_400_000 + 7 * 3600_000,
    ...extra,
  });

  it("never drops a date, sorts oldest first, and lets newer values win", () => {
    const stored = [row("2026-09-01", { reach: 10, newFollows: 1 }), row("2026-09-02", { reach: 20 })];
    const merged = mergeInsightDays(stored, [row("2026-09-02", { reach: 25, newFollows: 3 }), row("2026-08-31", { reach: 5 })]);
    expect(merged.map((d) => d.date)).toEqual(["2026-08-31", "2026-09-01", "2026-09-02"]);
    expect(merged[1]).toMatchObject({ reach: 10, newFollows: 1 });
    expect(merged[2]).toMatchObject({ reach: 25, newFollows: 3 });
    // an empty refresh keeps everything
    expect(mergeInsightDays(merged, [])).toEqual(merged);
  });

  it("keeps a stored value the newer row lacks", () => {
    const merged = mergeInsightDays([row("2026-09-01", { reach: 10, newFollows: 4 })], [row("2026-09-01", { reach: 12 })]);
    expect(merged).toEqual([{ ...row("2026-09-01"), reach: 12, newFollows: 4 }]);
  });

  it("skips rows without a proper date", () => {
    const junk = [{ date: "yesterday", endTime: 1, reach: 1 }, null] as unknown as InsightDay[];
    expect(mergeInsightDays(junk, [row("2026-09-01", { reach: 1 })]).map((d) => d.date)).toEqual(["2026-09-01"]);
  });
});

describe("mergeAccountStats", () => {
  const stored: MineAccountStats = {
    fetchedAt: 1,
    days: [{ date: "2026-09-01", endTime: 2, reach: 10 }],
    reach30d: 10,
    profileViews: 44,
    countries: [{ label: "US", value: 9 }],
  };

  it("is fill-only: what this fetch couldn't read keeps the stored value", () => {
    const merged = mergeAccountStats(stored, { fetchedAt: 5, days: [], websiteClicks: 3 });
    expect(merged).toMatchObject({
      fetchedAt: 5,
      days: stored.days,
      reach30d: 10,
      profileViews: 44,
      websiteClicks: 3,
      countries: [{ label: "US", value: 9 }],
    });
  });

  it("takes every value the fetch did read", () => {
    const next: MineAccountStats = {
      fetchedAt: 5,
      days: [{ date: "2026-09-02", endTime: 3, reach: 7 }],
      reach30d: 7,
      profileViews: 50,
      countries: [{ label: "GB", value: 2 }],
    };
    expect(mergeAccountStats(stored, next)).toMatchObject(next);
    expect(mergeAccountStats(undefined, next)).toBe(next);
  });
});

describe("nextGraphDaily", () => {
  const NOW = Date.UTC(2026, 8, 24, 6, 0, 3);
  const row = (date: string, reach: number): InsightDay => ({
    date,
    endTime: Date.parse(`${date}T07:00:00Z`) + DAY_MS,
    reach,
  });
  const recent = [row("2026-09-21", 5100), row("2026-09-22", 5400)];

  it("backfills two years the first time, before the stats call's 30 days", async () => {
    const backfill = vi.fn(async () => ({ days: [row("2024-09-23", 70), row("2026-08-01", 90)], complete: true }));
    const next = await nextGraphDaily(undefined, recent, NOW, backfill);
    expect(backfill).toHaveBeenCalledWith(NOW - 730 * DAY_MS, NOW - 30 * DAY_MS);
    expect(next).toEqual({
      fetchedAt: NOW,
      backfilledAt: NOW,
      days: [row("2024-09-23", 70), row("2026-08-01", 90), ...recent],
    });
  });

  it("reaches back from now when the stats call read no days", async () => {
    const backfill = vi.fn(async () => ({ days: [row("2026-09-22", 1)], complete: true }));
    await nextGraphDaily(undefined, [], NOW, backfill);
    expect(backfill).toHaveBeenCalledWith(NOW - 730 * DAY_MS, NOW);
  });

  it("tries the backfill again until one finishes, keeping what it read", async () => {
    const cut = await nextGraphDaily(undefined, recent, NOW, async () => ({
      days: [row("2026-08-01", 90)],
      complete: false,
    }));
    expect(cut?.backfilledAt).toBeUndefined();
    expect(cut?.days).toHaveLength(3);
    const failed = await nextGraphDaily(cut!, recent, NOW + 1, async () => {
      throw new Error("rate limited");
    });
    expect(failed?.backfilledAt).toBeUndefined();
    expect(failed?.days).toEqual(cut?.days);
  });

  it("later runs only merge the recent days and never shrink the file", async () => {
    const stored: GraphDaily = {
      fetchedAt: NOW - DAY_MS,
      backfilledAt: NOW - 10 * DAY_MS,
      days: [row("2024-09-23", 70), row("2026-09-21", 5000)],
    };
    const backfill = vi.fn();
    const next = await nextGraphDaily(stored, [row("2026-09-22", 5400)], NOW, backfill);
    expect(backfill).not.toHaveBeenCalled();
    expect(next).toEqual({
      fetchedAt: NOW,
      backfilledAt: stored.backfilledAt,
      days: [row("2024-09-23", 70), row("2026-09-21", 5000), row("2026-09-22", 5400)],
    });
    // nothing new: nothing to write
    expect(await nextGraphDaily(stored, [], NOW, backfill)).toBeNull();
  });
});
