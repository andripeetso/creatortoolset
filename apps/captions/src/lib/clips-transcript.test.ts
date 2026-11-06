import { describe, expect, it } from "vitest";
import {
  captionCueAt,
  clipCaptionCues,
  transcriptParagraphs,
  type ClipWord,
} from "./clips";

const w = (text: string, start: number, end = start + 0.3): ClipWord => ({
  text,
  start,
  end,
});

describe("transcriptParagraphs", () => {
  it("breaks after a few sentences", () => {
    const words = [
      w("Hey,", 0),
      w("Morgan.", 0.4),
      w("So", 0.8),
      w("this", 1.1),
      w("is", 1.4),
      w("quick.", 1.7),
      w("Next", 2.1),
      w("thought", 2.4),
      w("starts", 2.7),
      w("here.", 3.0),
      w("And", 3.4),
      w("another", 3.7),
      w("sentence", 4.0),
      w("follows.", 4.3),
    ];
    const paras = transcriptParagraphs(words);
    expect(paras.length).toBeGreaterThan(1);
    expect(paras.flat().map((x) => x.text)).toEqual(words.map((x) => x.text));
  });

  it("starts a new paragraph at chapter cuts", () => {
    const words = [
      w("Intro", 0),
      w("talk.", 0.4),
      w("Later", 40),
      w("chapter.", 40.4),
    ];
    const paras = transcriptParagraphs(words, [{ t: 40, title: "Later" }]);
    expect(paras).toHaveLength(2);
    expect(paras[1][0].text).toBe("Later");
  });

  it("breaks on a long pause", () => {
    const words = [
      w("One", 0),
      w("two", 0.3),
      w("three", 0.6),
      w("four", 0.9),
      w("five", 1.2),
      w("six.", 1.5),
      w("After", 4.0),
      w("silence.", 4.3),
    ];
    const paras = transcriptParagraphs(words);
    expect(paras).toHaveLength(2);
    expect(paras[1][0].text).toBe("After");
  });
});

describe("clipCaptionCues", () => {
  it("packs a short phrase into one cue", () => {
    const words = [w("Hey", 0), w("there.", 0.3)];
    const cues = clipCaptionCues(words);
    expect(cues).toHaveLength(1);
    expect(cues[0].words.map((x) => x.text)).toEqual(["Hey", "there."]);
  });

  it("starts a new cue after a sentence", () => {
    const words = [
      w("Done.", 0),
      w("Next", 0.4),
      w("bit.", 0.7),
    ];
    const cues = clipCaptionCues(words);
    expect(cues[0].words.map((x) => x.text)).toEqual(["Done."]);
    expect(cues[1].words.map((x) => x.text)).toEqual(["Next", "bit."]);
  });

  it("breaks on a pause", () => {
    const words = [
      w("One", 0),
      w("two", 0.3),
      w("Later", 2.0),
      w("on.", 2.3),
    ];
    const cues = clipCaptionCues(words);
    expect(cues).toHaveLength(2);
    expect(cues[1].words[0].text).toBe("Later");
  });

  it("finds the cue under the playhead", () => {
    const cues = clipCaptionCues([
      w("Hello", 0, 0.4),
      w("world.", 0.4, 0.8),
      w("Bye.", 2, 2.4),
    ]);
    expect(captionCueAt(cues, 0.2)?.words[0].text).toBe("Hello");
    expect(captionCueAt(cues, 2.1)?.words[0].text).toBe("Bye.");
    expect(captionCueAt(cues, 1.2)).toBeNull();
  });
});
