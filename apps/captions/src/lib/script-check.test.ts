import { describe, expect, it } from "vitest";
import { applyScriptEdits } from "./script-check";
import type { Word } from "./types";

const timed = (text: string, from = 0): Word[] =>
  text.split(" ").map((t, i) => ({
    id: from + i + 1,
    text: t,
    start: (from + i) * 0.5,
    end: (from + i) * 0.5 + 0.4,
    confidence: 0.5,
    timing: "aligned" as const,
  }));

const ids = () => {
  let next = 100;
  return () => next++;
};

const texts = (groups: Word[][]) => groups.map((g) => g.map((w) => w.text).join(" "));

describe("applyScriptEdits", () => {
  it("keeps each word's timing when the word count stays", () => {
    const words = timed("in the prawn position.");
    const { groups, fixes } = applyScriptEdits([words], [{ from: 2, to: 2, text: "prone" }], ids());
    const fixed = groups[0][2];
    expect(texts(groups)).toEqual(["in the prone position."]);
    expect(fixed).toMatchObject({ id: 100, start: words[2].start, end: words[2].end, timing: "aligned" });
    // the engine's confidence was in "prawn", not in the fix
    expect(fixed.confidence).toBeUndefined();
    // every other word is the same object
    expect(groups[0][1]).toBe(words[1]);
    expect(fixes).toEqual([{ ids: [100], before: "prawn", after: "prone" }]);
  });

  it("spreads a joined run's time over its new words by length", () => {
    const words = timed("at tiny acro batics, we");
    const { groups, fixes } = applyScriptEdits(
      [words],
      [{ from: 1, to: 3, text: "Tiny Acrobatics," }],
      ids(),
    );
    expect(texts(groups)).toEqual(["at Tiny Acrobatics, we"]);
    const [puppy, acro] = [groups[0][1], groups[0][2]];
    expect(puppy.start).toBe(words[1].start);
    expect(acro.end).toBe(words[3].end);
    expect(puppy.end).toBe(acro.start);
    // "Acrobatics" is longer than "Tiny", so it gets more of the time
    expect(acro.end - acro.start).toBeGreaterThan(puppy.end - puppy.start);
    expect(fixes[0]).toEqual({ ids: [100, 101], before: "tiny acro batics,", after: "Tiny Acrobatics," });
  });

  it("puts a run that crossed captions into the caption of its first word", () => {
    const first = timed("I'm Andre");
    const second = timed("Pisto, and I", 2);
    const { groups } = applyScriptEdits(
      [first, second],
      [{ from: 1, to: 2, text: "Ronnie Harker," }],
      ids(),
    );
    expect(texts(groups)).toEqual(["I'm Ronnie Harker,", "and I"]);
  });

  it("drops a caption the fix emptied", () => {
    const { groups } = applyScriptEdits(
      [timed("at tiny"), timed("acro", 2), timed("batics we", 3)],
      [{ from: 1, to: 3, text: "Tiny Acrobatics" }],
      ids(),
    );
    expect(texts(groups)).toEqual(["at Tiny Acrobatics", "we"]);
  });

  it("keeps cadence marks: new words continue the first word's thought", () => {
    const words = timed("so tiny acro batics").map((w, i) => ({ ...w, cut: (i === 1 ? 2 : 0) as 0 | 2 }));
    const { groups } = applyScriptEdits([words], [{ from: 1, to: 3, text: "Tiny Acrobatics" }], ids());
    expect(groups[0].map((w) => w.cut)).toEqual([0, 2, 0]);
  });

  it("ignores overlapping, out-of-range and empty edits", () => {
    const words = timed("the prawn position");
    const { groups, fixes } = applyScriptEdits(
      [words],
      [
        { from: 1, to: 1, text: "prone" },
        { from: 1, to: 2, text: "prone position" },
        { from: 2, to: 5, text: "x" },
        { from: 0, to: 0, text: "  " },
      ],
      ids(),
    );
    expect(texts(groups)).toEqual(["the prone position"]);
    expect(fixes).toHaveLength(1);
  });
});
