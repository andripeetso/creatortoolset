import { describe, expect, it } from "vitest";
import type { Line, Sentence } from "../../contracts/editor";
import type { TimedWord } from "../library/transcribe";
import { takeCuts } from "./takes";

// The take picker's takes: each cut as the draft step cuts it, in source frames; one with no words found is the take as said.

const fps = 25;
const words: TimedWord[] = [
  // take 1 (sentence 1): a restart, then the line
  { w: "so", s: 1, e: 1.2 }, { w: "this", s: 1.3, e: 1.5 }, { w: "so", s: 3, e: 3.2 }, { w: "this", s: 3.3, e: 3.5 }, { w: "is", s: 3.6, e: 3.8 }, { w: "it", s: 3.9, e: 4.1 },
  // take 2 (sentence 2)
  { w: "so", s: 8, e: 8.2 }, { w: "this", s: 8.3, e: 8.5 }, { w: "is", s: 8.6, e: 8.8 }, { w: "it", s: 8.9, e: 9.1 },
];
const sentences: Sentence[] = [
  { n: 1, src: "rec1", text: "so this so this is it", s: 1, e: 4.1, w0: 0, w1: 5 },
  { n: 2, src: "rec1", text: "so this is it", s: 8, e: 9.1, w0: 6, w1: 9 },
  { n: 3, src: "gone", text: "so this is it", s: 0, e: 1, w0: 0, w1: 3 },
];
const line: Line = { id: "L1", text: "so this is it", takes: [{ first: 2, last: 2, score: 0.9 }, { first: 1, last: 1, score: 0.7 }, { first: 3, last: 3, score: 0.5 }] };

describe("take picker cuts", () => {
  it("cuts each take as a draft would, best first, inside its own seconds", () => {
    const got = takeCuts(line, sentences, { rec1: words }, {}, { rec1: fps });
    expect(got.map((t) => [t.first, t.src])).toEqual([[2, "rec1"], [1, "rec1"]]); // the take on a source not in the library is left out
    const covers = (cut: [number, number][], sec: number) => cut.some(([x, y]) => x <= sec * fps && sec * fps < y);
    // take 2 keeps its words and nothing of take 1 before it
    expect(covers(got[0]!.cut, 8.1) && covers(got[0]!.cut, 9)).toBe(true);
    expect(got[0]!.cut.every(([x, y]) => y > x && x >= 4.1 * fps)).toBe(true);
    // take 1 keeps its line, and its restart (the first "so this", 1.0-1.5 s) is cut
    expect(covers(got[1]!.cut, 3.95)).toBe(true);
    expect(covers(got[1]!.cut, 1.1)).toBe(false);
  });

  it("a take whose words are missing is laid as said, its first sentence's start to its last's end", () => {
    const [t] = takeCuts({ ...line, takes: [line.takes[0]!] }, sentences, {}, {}, { rec1: fps });
    expect(t!.cut).toEqual([[200, 228]]);
  });
});
