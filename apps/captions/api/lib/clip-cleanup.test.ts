import { describe, expect, it } from "vitest";
import {
  applyTranscriptCleanup,
  cleanupSlice,
  cleanupUserPrompt,
  numberedWords,
  parseCleanupPayload,
  spokenText,
} from "./clip-cleanup";

const w = (text: string, start: number, end = start + 0.2) => ({
  text,
  start,
  end,
});

describe("parseCleanupPayload", () => {
  it("reads drop indices and text fixes", () => {
    const payload = parseCleanupPayload(
      '```json\n{"drop":[0,2],"fixes":[{"i":1,"text":"So,"}]}\n```',
    );
    expect(payload.drop).toEqual([0, 2]);
    expect(payload.fixes).toEqual([{ i: 1, text: "So," }]);
  });

  it("allows an empty cleanup", () => {
    expect(parseCleanupPayload('{"drop":[],"fixes":[]}')).toEqual({
      drop: [],
      fixes: [],
    });
  });
});

describe("applyTranscriptCleanup", () => {
  const words = [
    w("um", 0),
    w("the", 0.2),
    w("button", 0.4),
    w("uh", 0.6),
    w("is", 0.8),
    w("red", 1),
  ];

  it("drops filler and keeps timings on the rest", () => {
    const next = applyTranscriptCleanup(words, {
      drop: [0, 3],
      fixes: [{ i: 1, text: "The" }],
    });
    expect(next.map((x) => x.text)).toEqual(["The", "button", "is", "red"]);
    expect(next[0].start).toBe(0.2);
    expect(next[1].start).toBe(0.4);
  });

  it("refuses to delete every word", () => {
    expect(() =>
      applyTranscriptCleanup(words, {
        drop: [0, 1, 2, 3, 4, 5],
        fixes: [],
      }),
    ).toThrow(/whole transcript/);
  });

  it("can replace a mangled token with a short phrase", () => {
    const next = applyTranscriptCleanup(words, {
      drop: [],
      fixes: [{ i: 2, text: "but then" }],
    });
    expect(next[2].text).toBe("but then");
    expect(next[2].start).toBe(0.4);
  });
});

describe("cleanup prompt", () => {
  it("includes spoken text, indices, and confidence", () => {
    const prompt = cleanupUserPrompt(
      [
        { text: "Click", start: 0, end: 0.2, confidence: 0.99 },
        { text: "except", start: 0.2, end: 0.4, confidence: 0.41 },
      ],
      10,
    );
    expect(prompt).toContain("Spoken:\nClick except");
    expect(prompt).toContain("10\tClick\t0.99");
    expect(prompt).toContain("11\texcept\t0.41");
    expect(prompt).toContain("confidence 0-1");
  });

  it("passes previous words as uneditable context", () => {
    const prompt = cleanupUserPrompt(
      [w("next", 1)],
      1,
      [w("Hello", 0)],
    );
    expect(prompt).toContain("Previous context (do not edit):\nHello");
    expect(prompt).toContain("1\tnext");
  });
});

describe("cleanupSlice", () => {
  it("keeps a tail of previous words for context", () => {
    const many = Array.from({ length: 30 }, (_, i) => w(`w${i}`, i));
    const { slice, previous } = cleanupSlice(many, 25, 10);
    expect(slice.map((x) => x.text)).toEqual(["w25", "w26", "w27", "w28", "w29"]);
    expect(previous[0].text).toBe("w1");
    expect(previous.at(-1)?.text).toBe("w24");
  });
});

describe("numberedWords", () => {
  it("joins index and text", () => {
    expect(numberedWords([w("Hi", 0), w("there", 0.2)])).toBe("0\tHi\n1\tthere");
    expect(spokenText([w("Hi", 0), w("there", 0.2)])).toBe("Hi there");
  });
});
