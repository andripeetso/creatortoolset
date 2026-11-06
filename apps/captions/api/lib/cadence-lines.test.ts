import { describe, expect, it, vi } from "vitest";
import {
  cadencePrompt,
  hedged,
  marksFromLines,
  parseThoughtLines,
  longThoughts,
  splitAtSentences,
  splitPrompt,
} from "./cadence-lines";

const words = (text: string) => text.split(" ").map((t) => ({ text: t }));

describe("thought lines to word marks", () => {
  const w = words("So the first thing is movement every single day from the very beginning. Doing as much");

  it("marks each line start as a new thought and each | as a split point", () => {
    const marks = marksFromLines(
      [
        "So the first thing is",
        "movement | every single day",
        "from the very beginning.",
        "Doing as much",
      ],
      w,
    );
    expect(marks).toEqual([2, 0, 0, 0, 0, 2, 1, 0, 0, 2, 0, 0, 0, 2, 0, 0]);
  });

  it("still starts a thought at every sentence end the model ran on past", () => {
    const marks = marksFromLines(["So the first thing is movement every single day from the very beginning. Doing as much"], w);
    expect(marks[13]).toBe(2);
    expect(marks.filter((m) => m === 2)).toHaveLength(2);
  });

  // a realistic chunk: the model may tidy a few words out of hundreds
  const filler = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

  it("aligns around repeated words the model dropped", () => {
    const repeated = words(`So So for for example, example, now when we're at home, ${filler}`);
    const marks = marksFromLines(["So for example,", "now when we're at home,", filler], repeated);
    expect(marks).toHaveLength(repeated.length);
    expect(marks[repeated.findIndex((x) => x.text === "now")]).toBe(2);
    expect(marks[repeated.findIndex((x) => x.text === "word0")]).toBe(2);
  });

  it("carries a line start through a word the model reworded", () => {
    const w2 = words(`${filler} we're going home now`);
    const marks = marksFromLines([filler, "we are going home now"], w2);
    // "we're" came back as "we are": the thought still starts on "we're"
    expect(marks[w2.findIndex((x) => x.text === "we're")]).toBe(2);
    expect(marks[w2.findIndex((x) => x.text === "going")]).toBe(0);
  });

  it("rejects an answer that changed the transcript", () => {
    expect(() =>
      marksFromLines(["something else entirely"], words("keep moving forward and trust yourself")),
    ).toThrow("changed the transcript");
  });

  it("parses the lines out of a fenced answer", () => {
    expect(parseThoughtLines('```json\n{"lines":["a b","c"]}\n```')).toEqual(["a b", "c"]);
    expect(() => parseThoughtLines('{"lines":[]}')).toThrow("no caption lines");
  });
});

describe("splitting a reel into pieces", () => {
  // 30 sentences of 8 words: "s0w0 s0w1 … s0w7." and so on
  const reel = Array.from({ length: 30 }, (_, s) =>
    Array.from({ length: 8 }, (_, w) => `s${s}w${w}${w === 7 ? "." : ""}`),
  )
    .flat()
    .map((t) => ({ text: t }));

  it("only cuts at sentence ends, near the target size, and covers every word", () => {
    const pieces = splitAtSentences(reel, 40);
    expect(pieces[0][0]).toBe(0);
    expect(pieces[pieces.length - 1][1]).toBe(reel.length);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i][0]).toBe(pieces[i - 1][1]);
      expect(reel[pieces[i][0] - 1].text.endsWith(".")).toBe(true);
    }
    for (const [a, b] of pieces) expect(b - a).toBeLessThanOrEqual(60);
  });

  it("keeps a short reel in one piece", () => {
    expect(splitAtSentences(reel.slice(0, 50), 40)).toEqual([[0, 50]]);
  });

  it("never tells the thought pass the box width", () => {
    expect(cadencePrompt(words("a b"))).not.toContain("characters");
  });

  it("asks the split pass for pieces a little under the box width", () => {
    // models can't count characters exactly
    expect(splitPrompt(["is one of our most common questions"], 26)).toContain("at most 23 characters");
  });

  it("shows the neighbouring text as context only", () => {
    const prompt = cadencePrompt(words("b c."), { before: "a.", after: "d." });
    expect(prompt).toMatch(/Just before this part \(context only[^\n]*\n+a\./);
    expect(prompt).toContain("Transcript (2 words):\nb c.");
    expect(prompt).toMatch(/Just after this part \(context only[^\n]*\n+d\./);
  });
});

describe("hedged model requests", () => {
  const later = <T,>(ms: number, value: T, fail = false) => (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => (fail ? reject(new Error(String(value))) : resolve(value)), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });

  it("takes the first answer when it comes back in time, without a second request", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(later(10_000, "first"));
    const result = hedged(attempt, 25_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe("first");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("starts a second request when the first is slow, and uses whichever answers first", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const slowThenFast = [later(90_000, "slow"), later(12_000, "fast")];
    const result = hedged((signal) => {
      signals.push(signal);
      return slowThenFast[signals.length - 1](signal);
    }, 25_000);
    await vi.advanceTimersByTimeAsync(37_000);
    await expect(result).resolves.toBe("fast");
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    vi.useRealTimers();
  });

  it("does not retry an attempt that already failed on every provider", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(later(5_000, "all providers failed", true));
    const result = hedged(attempt, 25_000);
    const settled = expect(result).rejects.toThrow("all providers failed");
    await vi.advanceTimersByTimeAsync(40_000);
    await settled;
    expect(attempt).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stops both requests when the user stops the match", async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const signals: AbortSignal[] = [];
    const result = hedged((signal) => {
      signals.push(signal);
      return later(90_000, "x")(signal);
    }, 25_000, outer.signal);
    const settled = expect(result).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(26_000);
    outer.abort();
    await settled;
    expect(signals.every((s) => s.aborted)).toBe(true);
    vi.useRealTimers();
  });
});

describe("split points for long thought lines", () => {
  it("finds only the thought lines wider than the box", () => {
    const w = words("So Tiny Acrobatics is built for zero to eighteen months. But within");
    const marks = w.map((_, i) => (i === 0 || i === 5 || i === 10 ? 2 : 0)) as (0 | 1 | 2)[];
    // "So Tiny Acrobatics is built" is 27, "for zero to eighteen months." is 28
    expect(longThoughts(w, marks, 26)).toEqual([
      [0, 5],
      [5, 10],
    ]);
    expect(longThoughts(w, marks, 30)).toEqual([]);
  });
});
