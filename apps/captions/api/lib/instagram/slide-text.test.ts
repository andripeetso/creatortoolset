import { describe, expect, it } from "vitest";
import {
  cleanPostSlideText,
  cleanSlideText,
  isCreatorLine,
  isNoiseLine,
  stripSharedLines,
} from "./slide-text";
import type { Slide } from "./types";

const creator = { username: "readysetparent", fullName: "Ready Set Parent" };

describe("isCreatorLine / isNoiseLine", () => {
  it("recognises the creator header in its usual spellings", () => {
    expect(isCreatorLine("Ready Set Parent", creator)).toBe(true);
    expect(isCreatorLine("@readysetparent", creator)).toBe(true);
    expect(isCreatorLine("Ready Set Parent ✓ @readysetparent", creator)).toBe(true);
    expect(isCreatorLine("ready set parent", creator)).toBe(true);
  });

  it("keeps lines that merely mention the creator", () => {
    expect(isCreatorLine("Follow @readysetparent for more", creator)).toBe(false);
    expect(isCreatorLine("Ready Set Parent taught me this", creator)).toBe(false);
  });

  it("flags swipe hints, counters and arrows", () => {
    expect(isNoiseLine("Swipe →")).toBe(true);
    expect(isNoiseLine("3/14")).toBe(true);
    expect(isNoiseLine("→")).toBe(true);
    expect(isNoiseLine("Save this for later")).toBe(true);
    expect(isNoiseLine("Range does.")).toBe(false);
  });
});

describe("cleanSlideText", () => {
  it("drops the header and keeps the message", () => {
    const text = [
      "Ready Set Parent",
      "@readysetparent",
      "We've been told that committing early",
      "is how champions are made.",
      "",
      "Swipe →",
    ].join("\n");
    expect(cleanSlideText(text, creator)).toBe(
      "We've been told that committing early\nis how champions are made.",
    );
  });

  it("returns an empty string when only chrome was on the slide", () => {
    expect(cleanSlideText("Ready Set Parent\n@readysetparent\n2/10", creator)).toBe("");
  });
});

describe("stripSharedLines", () => {
  it("removes lines that repeat across most slides but keeps unique content", () => {
    const texts = [
      "THE SAMPLING SERIES\nFirst point here",
      "THE SAMPLING SERIES\nSecond point here",
      "THE SAMPLING SERIES\nThird point here",
      "Closing slide without the banner",
    ];
    expect(stripSharedLines(texts)).toEqual([
      "First point here",
      "Second point here",
      "Third point here",
      "Closing slide without the banner",
    ]);
  });

  it("leaves two-slide posts alone", () => {
    const texts = ["Same\nA", "Same\nB"];
    expect(stripSharedLines(texts)).toEqual(texts);
  });
});

describe("cleanPostSlideText", () => {
  const slide = (index: number, onScreenText: string, hook?: string): Slide => ({
    index,
    kind: "image",
    file: `media/0${index}.jpg`,
    mime: "image/jpeg",
    width: 1,
    height: 1,
    bytes: 1,
    transcript: { status: "skipped" },
    vision: { status: "done", onScreenText, hook },
  });

  it("cleans every slide and repairs a hook that was just the creator name", () => {
    const slides = [
      slide(0, "Ready Set Parent\n@readysetparent\nEarly hours don't predict greatness.", "Ready Set Parent"),
      slide(1, "Ready Set Parent\n@readysetparent\nRange does."),
      slide(2, "Ready Set Parent\n@readysetparent\nSampling wins."),
    ];
    expect(cleanPostSlideText(slides, { ...creator, id: "1" })).toBe(true);
    expect(slides[0].vision.onScreenText).toBe("Early hours don't predict greatness.");
    expect(slides[0].vision.hook).toBe("Early hours don't predict greatness.");
    expect(slides[2].vision.onScreenText).toBe("Sampling wins.");
    expect(cleanPostSlideText(slides, { ...creator, id: "1" })).toBe(false);
  });
});
