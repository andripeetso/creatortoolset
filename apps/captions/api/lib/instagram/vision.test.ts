import { describe, expect, it } from "vitest";
import { frameSampleTimes, parseVisionPayload, visionUserText } from "./vision";

describe("frameSampleTimes", () => {
  it("samples the opening, interior points, and the end of a long clip", () => {
    const t = frameSampleTimes(34.8, 6);
    expect(t).toHaveLength(6);
    expect(t[0]).toBe(0.3);
    expect(t.at(-1)).toBe(34.3);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  it("collapses near-duplicate times on short clips", () => {
    expect(frameSampleTimes(0.4)).toEqual([0]);
    const short = frameSampleTimes(2.4, 6);
    expect(short.length).toBeLessThan(6);
    expect(short.every((v, i) => i === 0 || v - short[i - 1] >= 0.5)).toBe(true);
  });
});

describe("parseVisionPayload", () => {
  it("accepts fenced JSON and both key spellings", () => {
    expect(
      parseVisionPayload('```json\n{"on_screen_text":"STOP\\nscrolling","description":"A hand","hook":"STOP scrolling"}\n```'),
    ).toEqual({ onScreenText: "STOP\nscrolling", description: "A hand", hook: "STOP scrolling" });
    expect(parseVisionPayload('{"onScreenText":"","description":"Beach at dusk"}')).toEqual({
      onScreenText: "",
      description: "Beach at dusk",
    });
  });

  it("reads what kind of text is on screen", () => {
    expect(parseVisionPayload('{"on_screen_text":"so this is not good","text_kind":"captions","description":"A talk"}').textKind).toBe("captions");
    expect(parseVisionPayload('{"on_screen_text":"","text_kind":"None","description":"A beach"}').textKind).toBe("none");
    expect(parseVisionPayload('{"on_screen_text":"x","text_kind":"maybe","description":"y"}').textKind).toBeUndefined();
  });

  it("rejects an answer with neither text nor description", () => {
    expect(() => parseVisionPayload('{"hook":"x"}')).toThrow();
    expect(() => parseVisionPayload("not json")).toThrow();
  });
});

describe("visionUserText", () => {
  it("describes the slide and the sampled frames", () => {
    const text = visionUserText({
      creator: "someone",
      kind: "carousel",
      index: 1,
      total: 3,
      slideKind: "video",
      durationS: 6.79,
      caption: "Long caption",
      frameTimes: [0.3, 3.4, 6.3],
    });
    expect(text).toContain("@someone");
    expect(text).toContain("Slide 2 of 3 (video, 6.8s)");
    expect(text).toContain("Caption (context only, not slide text): Long caption");
    expect(text).toContain("0.3s, 3.4s, 6.3s");
  });
});
