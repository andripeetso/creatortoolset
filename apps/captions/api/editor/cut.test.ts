import { describe, expect, it } from "vitest";
import type { TimedWord } from "../library/transcribe";
import { relisten } from "../lib/device-transcribe";
import { ENERGY_PER_SECOND, sentencesOf } from "./analyze";
import { CUT, cutTake, restarts, trim } from "./cut";

/** Words from 0.5 s, each 0.25 s long; a number is a pause (seconds) before the next word. */
function say(...parts: (string | number)[]): TimedWord[] {
  const out: TimedWord[] = [];
  let t = 0.5;
  for (const p of parts) {
    if (typeof p === "number") t += p;
    else {
      out.push({ w: p, s: t, e: t + 0.25 });
      t += 0.25;
    }
  }
  return out;
}
/** Loudness 0.5 while a word is said, 0 between, ENERGY_PER_SECOND reads a second. */
function loudness(words: TimedWord[]): Float32Array {
  const e = new Float32Array(Math.ceil((words[words.length - 1]!.e + 0.5) * ENERGY_PER_SECOND));
  for (const w of words) e.fill(0.5, Math.round(w.s * ENERGY_PER_SECOND), Math.round(w.e * ENERGY_PER_SECOND));
  return e;
}
const fps = 25;
const frame = (s: number) => Math.round(s * fps);
const covers = (segs: [number, number][], s: number) => segs.some(([a, b]) => a <= frame(s) && frame(s) < b);

describe("AI Editor cut", () => {
  it("a restart 'so this is | so this is for' keeps the second reading; 'very very' stays", () => {
    const w = say("so", "this", "is", 0.3, "so", "this", "is", "for", "puppies");
    expect(restarts(w)).toEqual([[0, 3]]);
    expect(restarts(say("so", "this", "progr", "so", "this", "program", "is"))).toEqual([[0, 3]]); // a cut-off word
    expect(restarts(say("very", "very", "good"))).toEqual([]);
    const { segments, removed } = cutTake(w, 0, w.length, "so this is for puppies", loudness(w), fps);
    expect(covers(segments, w[0]!.s + 0.1)).toBe(false);
    expect(covers(segments, w[3]!.s + 0.1)).toBe(true);
    expect(covers(segments, w[7]!.s + 0.1)).toBe(true);
    expect(removed.join(" | ")).toMatch(/so this is/);
  });

  it("a 1.2 s pause becomes no more than the kept tail and head", () => {
    const w = say("so", "this", 1.2, "is", "it");
    const { segments } = cutTake(w, 0, w.length, "so this is it", loudness(w), fps);
    expect(segments).toHaveLength(2);
    const [a, b] = segments as [[number, number], [number, number]];
    const kept = a[1] - frame(w[1]!.e) + (frame(w[2]!.s) - b[0]);
    expect(kept).toBeLessThanOrEqual(frame(CUT.keepTailS) + frame(CUT.keepHeadS));
    expect(kept).toBeGreaterThan(0);
  });

  it("trim drops a previous take's tail before the line", () => {
    const w = say("for", "puppies.", 0.5, "so", "this", "program", "is", "for", "puppies");
    expect(trim(w, "So this program is for puppies")).toEqual([2, 8]);
    const { segments, removed } = cutTake(w, 0, w.length, "So this program is for puppies", loudness(w), fps);
    expect(segments[0]![0]).toBeGreaterThanOrEqual(frame(w[1]!.e));
    expect(removed).toContain("before the line: for puppies.");
  });

  it("keeps the whole take when the line's text is not what was said", () => {
    expect(trim(say("we", "teach", "rolls"), "an overview of tumbling classes")).toEqual([0, 3]);
  });

  it("a phrase said twice inside the line is cut once, and the line keeps both its halves", () => {
    const line = "we teach every child to roll forward slowly on a soft mat";
    const w = say("we", "teach", "every", "child", "to", "roll", "forward", "slowly", 0.3, "to", "roll", "forward", "slowly", "on", "a", "soft", "mat");
    expect(trim(w, line)).toEqual([0, w.length]);
    // the same with a word misheard in the reading that was given up: only the line's text shows it is a restart
    const m = say("we", "teach", "every", "child", "to", "roll", "for", "wood", 0.3, "to", "roll", "forward", "slowly", "on", "a", "soft", "mat");
    expect(restarts(m)).toEqual([]);
    for (const words of [w, m]) {
      const { segments, removed } = cutTake(words, 0, words.length, line, loudness(words), fps);
      expect([0, 3, 8, 15].map((n) => covers(segments, words[n]!.s + 0.1))).toEqual([true, true, true, true]);
      expect([4, 7].map((n) => covers(segments, words[n]!.s + 0.1))).toEqual([false, false]);
      expect(removed.join(" | ")).toMatch(/false start: to roll for/);
    }
  });

  it("a false start is left out when the reading that follows has a word misheard", () => {
    const w = say("we", "teach", "every", "child", 0.9, "we", "teach", "any", "child", "to", "roll", "forward");
    expect(trim(w, "we teach every child to roll forward")).toEqual([4, 11]);
  });

  it("misheard words at the line's start and end do not cost it its first and last word", () => {
    expect(trim(say("if", "you're", "a", "puppy", "rolls", "forward"), "if your puppy rolls forward")).toEqual([0, 6]);
    expect(trim(say("a", "child", "rolls", "under", "the", "sofa", "mat"), "a child rolls on a soft mat")).toEqual([0, 7]);
  });

  it("speech nobody wrote down after the line stays out of it", () => {
    const w = say("we", "roll.", 2, "join", "us.");
    const e = loudness(w);
    e.fill(0.5, 1.7 * ENERGY_PER_SECOND, 2.3 * ENERGY_PER_SECOND); // said between the two sentences, in no transcript
    const { segments } = cutTake(w, 0, 2, "we roll", e, fps);
    expect(covers(segments, w[1]!.s + 0.1)).toBe(true);
    expect(covers(segments, 2)).toBe(false);
  });

  it("the on-device transcript's three faults: a false start, a phrase said twice, a last word timed into the next attempt", async () => {
    // what was said, each stretch of speech with a pause after it; the model wrote the three lines marked * and stretched a word over the rest
    const spoken = say("so", "we", "start", 0.8, "so", "we", "start", "with", "a", "slow", "roll", 0.4, "with", "a", "slow", "roll", "on", "the", "mat", 0.9, "so", "we", "stop", 1, "then", "we", "rest");
    const at = (n: number, e = spoken[n]!.e) => ({ text: spoken[n]!.w, start: spoken[n]!.s, end: e });
    const first = [at(0), at(1), at(2, spoken[6]!.s), at(6), at(7), at(8, spoken[13]!.s), at(13), at(14), at(15), at(16, spoken[17]!.s + 0.05), at(20), at(21), at(22)];
    const pcm = new Float32Array(Math.ceil((spoken[spoken.length - 1]!.e + 0.5) * 16000));
    for (const w of spoken) for (let i = Math.round(w.s * 16000); i < Math.round(w.e * 16000); i++) pcm[i] = 0.3 * Math.sin(i / 12);
    const e = loudness(spoken);
    const asked: number[] = [];
    const hear = async (from: number, to: number) => {
      asked.push(Math.round(to - from));
      return spoken.filter((w) => w.s >= from && w.s < to).map((w) => ({ text: w.w, start: w.s, end: w.e }));
    };
    const line = "so we start with a slow roll on the mat";
    /** The line's cut from a transcript, as the edit makes it: its sentences, the one that says the line, cut. */
    const cut = (heard: { text: string; start: number; end: number }[]) => {
      const words = heard.map((x) => ({ w: x.text, s: x.start, e: x.end }));
      const take = sentencesOf(words, "v", 1).find((s) => s.text.endsWith("on the mat"))!;
      return cutTake(words, take.w0, take.w1 + 1, line, e, fps).segments;
    };
    const faults = (segs: [number, number][]) => [0, 9, 18].map((n) => covers(segs, spoken[n]!.s + 0.1));
    expect(faults(cut(first))).toEqual([true, true, true]); // all three in the draft
    const again = await relisten(first, pcm, hear);
    expect(asked).toEqual([2, 2, 1]); // three stretches heard again, never the whole recording
    expect(again.map((x) => x.text).join(" ")).toBe("so we start so we start with a slow with a slow roll on the mat so we stop then we rest");
    const segments = cut(again);
    expect(faults(segments)).toEqual([false, false, false]);
    expect([3, 5, 10, 16].map((n) => covers(segments, spoken[n]!.s + 0.1))).toEqual([true, true, true, true]);
  });
});
