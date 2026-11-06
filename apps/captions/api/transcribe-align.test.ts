import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alignDeepgramWords, mergeOverlappingWindows } from "./transcribe";

describe("alignDeepgramWords", () => {
  it("keeps word confidence and the utterance that contains each word", () => {
    const words = alignDeepgramWords(
      [
        { word: "looking", punctuated_word: "looking", start: 0, end: 0.3, confidence: 0.98 },
        { word: "at", punctuated_word: "at", start: 0.32, end: 0.45, confidence: 0.9 },
        { word: "your", punctuated_word: "your", start: 1.3, end: 1.5, confidence: 0.4 },
        { word: "child", punctuated_word: "child?", start: 1.55, end: 1.9, confidence: 0.97 },
      ],
      [
        { start: 0, end: 0.5 },
        { start: 1.2, end: 2 },
      ],
    );
    expect(words.map((w) => [w.text, w.utterance, w.confidence, w.timing])).toEqual([
      ["looking", 0, 0.98, "aligned"],
      ["at", 0, 0.9, "aligned"],
      ["your", 1, 0.4, "aligned"],
      ["child?", 1, 0.97, "aligned"],
    ]);
  });
});
describe("mergeOverlappingWindows", () => {
  it("keeps a word both overlapping windows heard only once", () => {
    // window 0 covers 0–45 s, window 1 starts at 43 s; the cut is 44 s
    const merged = mergeOverlappingWindows([
      {
        offsetS: 0,
        words: [
          { text: "walked", start: 43.2, end: 43.6 },
          { text: "So", start: 44.04, end: 44.2 },
          { text: "for", start: 44.2, end: 44.44 },
        ],
      },
      {
        offsetS: 43,
        words: [
          { text: "walked", start: 0.25, end: 0.6 },
          { text: "So", start: 1.07, end: 1.23 },
          { text: "for", start: 1.23, end: 1.39 },
          { text: "example,", start: 1.44, end: 1.68 },
        ],
      },
    ]);
    expect(merged.map((w) => w.text)).toEqual(["walked", "So", "for", "example,"]);
  });

  it("removes the doubled words at both seams of the real reel", () => {
    const fx = JSON.parse(
      readFileSync(
        new URL("../src/lib/__fixtures__/cadence-clip-01.json", import.meta.url),
        "utf8",
      ),
    ) as {
      windowStepS: number;
      words: { text: string; start: number; end: number; utterance?: number }[];
    };
    // rebuild the three Deepgram windows the way they came back
    const windows = [0, 1, 2].map((k) => ({
      offsetS: k * fx.windowStepS,
      words: fx.words
        .filter((w) => Math.floor((w.utterance ?? 0) / 1000) === k)
        .map((w) => ({
          text: w.text,
          start: w.start - k * fx.windowStepS,
          end: w.end - k * fx.windowStepS,
        })),
    }));
    const text = mergeOverlappingWindows(windows)
      .map((w) => w.text)
      .join(" ");
    expect(fx.words.map((w) => w.text).join(" ")).toContain("Pi Pi dob dob onilrsu, onilrsu, bob bob");
    expect(text).toContain("Pi dob onilrsu, bob zfaz sa'lo in loda,");
    expect(text).toContain("bocatvi in. Coh bob dob blo fojnm szumc,");
  });
});
