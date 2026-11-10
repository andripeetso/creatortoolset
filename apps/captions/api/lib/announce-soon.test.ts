import { afterEach, describe, expect, it, vi } from "vitest";

const told: string[] = [];
vi.mock("./sync", () => ({ announce: (owner: string, topic: string) => told.push(`${owner}:${topic}`) }));
const { announceSoon } = await import("./announce-soon");

afterEach(() => vi.useRealTimers());

describe("announceSoon", () => {
  it("tells the first save at once, a burst once a second, and always the last", () => {
    vi.useFakeTimers();
    told.length = 0;
    for (let i = 0; i < 50; i++) announceSoon("tiny", "review"); // 50 ticks inside one second
    expect(told).toEqual(["tiny:review"]);
    vi.advanceTimersByTime(1000);
    expect(told).toEqual(["tiny:review", "tiny:review"]); // the trailing one: the job's last save
    vi.advanceTimersByTime(5000);
    expect(told).toHaveLength(2); // quiet: nothing more
    announceSoon("tiny", "review");
    announceSoon("other", "review"); // another account has its own window
    announceSoon(undefined, "review");
    expect(told).toEqual(["tiny:review", "tiny:review", "tiny:review", "other:review"]);
  });
});
