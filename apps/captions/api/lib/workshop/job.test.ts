import { afterEach, describe, expect, it, vi } from "vitest";

const heard: Array<[string, string]> = [];
vi.mock("../sync", () => ({ announce: (owner: string, topic: string) => heard.push([owner, topic]) }));
const { inJob, keepJob, saved, THROTTLE } = await import("./job");

afterEach(() => {
  heard.length = 0;
  vi.useRealTimers();
});

describe("inJob / saved", () => {
  it("announces a job's saves to its accounts, throttled, and once more when it ends", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = inJob(["tiny", "tiny", "admin", undefined], async () => {
      saved();
      await Promise.resolve().then(() => saved()); // the scope survives a .then chain
      await gate;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).toEqual([
      ["tiny", "workshop"],
      ["admin", "workshop"],
    ]);
    heard.length = 0;
    release();
    await done;
    expect(heard).toEqual([
      ["tiny", "workshop"],
      ["admin", "workshop"],
    ]); // the second save, flushed at the end
    heard.length = 0;
    vi.advanceTimersByTime(THROTTLE * 2);
    expect(heard).toEqual([]);
  });

  it("counts a save from a callback someone else calls, and says nothing for a job that saved nothing", async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(THROTTLE * 2);
    let later!: () => void;
    await inJob(["tiny"], async () => {
      later = keepJob(() => saved());
    });
    expect(heard).toEqual([]); // nothing saved yet
    setTimeout(() => later(), 0); // called from outside the job's own chain
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["tiny", "workshop"]]);
  });

  it("is quiet outside a job", () => {
    saved();
    expect(heard).toEqual([]);
  });
});
