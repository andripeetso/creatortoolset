import { describe, expect, it } from "vitest";
import type { TimedWord } from "../library/transcribe";
import { ENERGY_PER_SECOND } from "./analyze";
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
    const w = say("so", "this", "is", 0.3, "so", "this", "is", "for", "babies");
    expect(restarts(w)).toEqual([[0, 3]]);
    expect(restarts(say("so", "this", "progr", "so", "this", "program", "is"))).toEqual([[0, 3]]); // a cut-off word
    expect(restarts(say("very", "very", "good"))).toEqual([]);
    const { segments, removed } = cutTake(w, 0, w.length, "so this is for babies", loudness(w), fps);
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
    const w = say("for", "babies.", 0.5, "so", "this", "program", "is", "for", "babies");
    expect(trim(w, "So this program is for babies")).toEqual([2, 8]);
    const { segments, removed } = cutTake(w, 0, w.length, "So this program is for babies", loudness(w), fps);
    expect(segments[0]![0]).toBeGreaterThanOrEqual(frame(w[1]!.e));
    expect(removed).toContain("before the line: for babies.");
  });

  it("keeps the whole take when the line's text is not what was said", () => {
    expect(trim(say("we", "teach", "rolls"), "an overview of tumbling classes")).toEqual([0, 3]);
  });
});
