import { describe, expect, it } from "vitest";
import { capChapters, chapterCountRange, timedTranscript } from "./timed-transcript";

function wordsOver(seconds: number, every = 0.4): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let t = 0;
  let i = 0;
  while (t < seconds) {
    out.push({ text: `w${i}`, start: t });
    t += every;
    i++;
  }
  return out;
}

describe("timedTranscript", () => {
  it("keeps a short transcript in full", () => {
    const text = timedTranscript([
      { text: "Hello", start: 0 },
      { text: "there.", start: 0.5 },
    ]);
    expect(text).toContain("[00:00]");
    expect(text).toContain("Hello");
    expect(text).toContain("there.");
  });

  it("includes the end of a 16-minute transcript", () => {
    const text = timedTranscript(wordsOver(16 * 60));
    expect(text).toContain("[00:00]");
    expect(text).toMatch(/\[1[5-6]:\d\d]/);
  });

  it("still spans start to end when over budget", () => {
    const text = timedTranscript(wordsOver(3 * 3600), 4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("[00:00]");
    expect(text).toMatch(/\[1[7-9]\d:|\[2\d\d:/);
  });
});

describe("chapterCountRange", () => {
  it("keeps a 16-minute review in a scannable 5–8", () => {
    expect(chapterCountRange(16 * 60)).toEqual({ min: 5, max: 8 });
  });

  it("uses tighter caps on short clips", () => {
    expect(chapterCountRange(90)).toEqual({ min: 0, max: 3 });
    expect(chapterCountRange(5 * 60)).toEqual({ min: 3, max: 5 });
  });

  it("does not keep growing past an hour", () => {
    expect(chapterCountRange(8 * 60).max).toBe(8);
    expect(chapterCountRange(45 * 60).max).toBe(12);
    expect(chapterCountRange(180 * 60).max).toBe(12);
  });
});

describe("capChapters", () => {
  it("keeps the start and end when thinning", () => {
    const thinned = capChapters(
      [0, 60, 120, 180, 240, 300, 360, 420, 480, 540].map((t) => ({ t })),
      4,
    );
    expect(thinned.map((c) => c.t)).toEqual([0, 180, 360, 540]);
  });
});
