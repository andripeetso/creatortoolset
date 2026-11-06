import { describe, expect, it } from "vitest";
import { cadenceFitOf, layoutCues, boxCaps } from "./captions";
import { narrowerThanMatched } from "./store";
import { DEFAULT_STYLE, type CaptionStyle, type Word } from "./types";

const frame = { sourceWidth: 2160, sourceHeight: 3840, videoWidth: 2160, videoHeight: 3840 };
const matched: CaptionStyle = { ...DEFAULT_STYLE, fitBox: true, fontSizePct: 2.5, boxW: 70, boxH: 4 };

// two thoughts, each marked as a new line, with no split marks inside
const words: Word[] = "So Tiny Acrobatics is built for zero to eighteen months."
  .split(" ")
  .map((text, id) => ({ id, text, start: id * 0.3, end: id * 0.3 + 0.25, cut: id === 5 ? 2 : 0 }));

const stateFor = (style: CaptionStyle) => {
  const caps = boxCaps(style, frame.sourceWidth, frame.sourceHeight);
  return {
    ...frame,
    style,
    cues: layoutCues(words, caps),
    cadenceApplied: true,
    cadenceDirty: false,
    cadenceFit: cadenceFitOf(matched),
  };
};

describe("offering Re-match for this size", () => {
  it("stays hidden at the width the match planned for", () => {
    expect(narrowerThanMatched(stateFor(matched))).toBe(false);
  });

  it("shows when the box got narrower and lines broke where nothing was marked", () => {
    expect(narrowerThanMatched(stateFor({ ...matched, boxW: 40 }))).toBe(true);
  });

  it("stays hidden when the box got wider", () => {
    expect(narrowerThanMatched(stateFor({ ...matched, boxW: 90 }))).toBe(false);
  });

  it("leaves a transcript edit to the regular Re-match cadence", () => {
    expect(narrowerThanMatched({ ...stateFor({ ...matched, boxW: 40 }), cadenceDirty: true })).toBe(false);
  });
});
