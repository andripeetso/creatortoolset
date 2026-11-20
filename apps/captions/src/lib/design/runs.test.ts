import { describe, expect, it } from "vitest";
import type { TextLayer } from "@contracts/design";
import { facesOf, faceOf, ownFace, weightsOf } from "./fonts";
import { casedText, diffText, editRuns, normalRuns, patchRange, retext, setRuns, styleAt, styleRange, usesRuns, viewRange } from "./runs";
import { markBoxes } from "./draw";

const text = (more: Partial<TextLayer> = {}): TextLayer => ({ id: "t", type: "text", text: "Roll the mat out", font: "Inter", size: 100, color: "#111111", align: "left", x: 0, y: 0, w: 1000, h: 400, ...more });
/** Every letter as wide as a tenth of its font's size: widths a test can count. */
const measure = (font: string, s: string) => (Number(/ ([\d.]+)px/.exec(font)![1]) / 10) * s.length;

describe("runs in a text", () => {
  it("styles part of a text, joins the same styles side by side, and leaves out what the layer says already", () => {
    const t = styleRange(text(), 5, 8, { color: "#ff0000" });
    expect(t.runs).toEqual([{ start: 5, end: 8, color: "#ff0000" }]);
    // the next word in the same colour: one run
    expect(styleRange(t, 8, 12, { color: "#ff0000" }).runs).toEqual([{ start: 5, end: 12, color: "#ff0000" }]);
    // part of it set back to the layer's colour: split in two
    expect(styleRange(styleRange(t, 8, 12, { color: "#ff0000" }), 8, 9, { color: "#111111" }).runs).toEqual([
      { start: 5, end: 8, color: "#ff0000" },
      { start: 9, end: 12, color: "#ff0000" },
    ]);
    // a second style over part of a run: the run is cut where they differ
    expect(styleRange(t, 7, 12, { weight: 800 }).runs).toEqual([
      { start: 5, end: 7, color: "#ff0000" },
      { start: 7, end: 8, color: "#ff0000", weight: 800 },
      { start: 8, end: 12, weight: 800 },
    ]);
    // switching a switch off where the layer has none takes the run away
    expect(styleRange(styleRange(text(), 0, 4, { italic: true }), 0, 4, { italic: false }).runs).toBeUndefined();
  });

  it("styles the whole text as the layer's own, and no run says otherwise any more", () => {
    const t = styleRange(styleRange(text(), 5, 8, { color: "#ff0000", size: 140 }), 0, 16, { color: "#00ff00" });
    expect(t.color).toBe("#00ff00");
    expect(t.runs).toEqual([{ start: 5, end: 8, size: 140 }]);
    // a switch off for all of it takes the field off
    expect(styleRange(text({ underline: true }), 0, 16, { underline: false }).underline).toBeUndefined();
  });

  it("moves runs with the words as they are typed: what is typed takes the style of the letter before it", () => {
    const t = styleRange(text(), 5, 8, { color: "#ff0000" }); // "the" red
    // typed at the end of the red word: red too
    const a = editRuns(t, 8, 0, "e");
    expect(a.text).toBe("Roll thee mat out");
    expect(a.runs).toEqual([{ start: 5, end: 9, color: "#ff0000" }]);
    // typed before the red word (after the space): not red, and the red word moves along
    const b = editRuns(t, 5, 0, "all ");
    expect(b.text).toBe("Roll all the mat out");
    expect(b.runs).toEqual([{ start: 9, end: 12, color: "#ff0000" }]);
    // typed at the very start of a text whose first word is styled: in its style
    expect(editRuns(styleRange(text(), 0, 4, { weight: 800 }), 0, 0, "X").runs).toEqual([{ start: 0, end: 5, weight: 800 }]);
    // the red word taken out whole: the run goes
    expect(editRuns(t, 4, 4, "").runs).toBeUndefined();
    // a part of it taken out with what is before it: what is left stays red
    expect(editRuns(t, 3, 4, "").runs).toEqual([{ start: 3, end: 4, color: "#ff0000" }]);
    // pasted over the red word: the paste is in the style of the letter before (plain)
    expect(editRuns(t, 5, 3, "a").runs).toBeUndefined();
  });

  it("finds where a text changed, using the caret to say which of two equal letters was typed", () => {
    expect(diffText("Roll", "Rolls")).toEqual({ at: 4, removed: 0, inserted: "s" });
    expect(diffText("Roll the", "Roll")).toEqual({ at: 4, removed: 4, inserted: "" });
    expect(diffText("abc", "aXc")).toEqual({ at: 1, removed: 1, inserted: "X" });
    // "aa" from "a": by the letters alone, at the end; with the caret after the first, the first was typed
    expect(diffText("a", "aa")).toEqual({ at: 1, removed: 0, inserted: "a" });
    expect(diffText("a", "aa", 1)).toEqual({ at: 0, removed: 0, inserted: "a" });
    // a letter taken out of "aa" with the caret at the start: the first
    expect(diffText("aa", "a", 0)).toEqual({ at: 0, removed: 1, inserted: "" });
  });

  it("trims a text's ends as its runs follow", () => {
    const t = styleRange(text({ text: "  Roll the mat  " }), 7, 10, { color: "#ff0000" });
    const done = retext(t, t.text);
    expect(done.text).toBe("Roll the mat");
    expect(done.runs).toEqual([{ start: 5, end: 8, color: "#ff0000" }]);
  });

  it("keeps runs inside the text, in order, never overlapping; the later of two over the same letters wins", () => {
    const t = normalRuns(text({ text: "Roll", runs: [{ start: 2, end: 99, color: "#ff0000" }, { start: -3, end: 1, size: 120 }, { start: 3, end: 4, color: "#00ff00" }, { start: 1, end: 1, weight: 900 }] }));
    expect(t.runs).toEqual([
      { start: 0, end: 1, size: 120 },
      { start: 2, end: 3, color: "#ff0000" },
      { start: 3, end: 4, color: "#00ff00" },
    ]);
    expect(normalRuns(text({ runs: [{ start: 0, end: 4, color: "#111111" }] })).runs).toBeUndefined();
  });

  it("shows a style panel the picked letters' style, and puts what it changes on them alone", () => {
    const t = styleRange(text(), 5, 8, { color: "#ff0000", weight: 800 });
    expect(viewRange(t, 5, 8)).toMatchObject({ color: "#ff0000", weight: 800 });
    expect(styleAt(t, 0)).toMatchObject({ color: "#111111", font: "Inter" });
    // underline the picked word; the alignment the panel changed goes to the whole layer
    const u = patchRange(t, (l) => ({ ...l, underline: true, align: "center" }), 5, 8);
    expect(u.align).toBe("center");
    expect(u.underline).toBeUndefined();
    expect(u.runs).toEqual([{ start: 5, end: 8, color: "#ff0000", weight: 800, underline: true }]);
    // its letter spacing taken off (the panel sets none as undefined)
    const s = patchRange(styleRange(text({ spacing: 4 }), 0, 4, { spacing: 10 }), (l) => ({ ...l, spacing: undefined }), 0, 4);
    expect(s.spacing).toBe(4);
    expect(s.runs).toEqual([{ start: 0, end: 4, spacing: 0 }]);
  });

  it("sets the case it is drawn in, the words kept as typed", () => {
    expect(casedText(text({ text: "roll the MAT", case: "title" }))).toBe("Roll The MAT");
    expect(casedText(text({ text: "Roll", case: "lower" }))).toBe("roll");
    expect(casedText(text({ text: "Roll", upper: true }))).toBe("ROLL");
    expect(usesRuns(text())).toBe(false);
    expect(usesRuns(text({ case: "small" }))).toBe(true);
  });
});

describe("laying out a text with runs", () => {
  it("wraps words made of several styles where a plain text of the same widths wraps", () => {
    // 10 a letter at size 100; "the" twice as large
    const t = styleRange(text({ w: 90 }), 5, 8, { size: 200 });
    const set = setRuns(t, measure);
    expect(set.lines.map((r) => r.text)).toEqual(["Roll", "the", "mat out"]);
    expect(set.lines.map((r) => r.width)).toEqual([40, 60, 70]);
    // a line is as high as its largest letters need, never less than the layer's
    expect(set.lines.map((r) => Math.round(r.height))).toEqual([115, 230, 115]);
    expect(set.lines[1]!.pieces.map((p) => p.size)).toEqual([200]);
  });

  it("splits a word into pieces where its style changes, and a space takes the style of the letter it is", () => {
    const t = styleRange(text({ text: "unbelievable deal" }), 2, 8, { color: "#ff0000", italic: true });
    const [line] = setRuns(t, measure).lines;
    expect(line!.pieces.map((p) => [p.text, p.color ?? "", p.slant])).toEqual([
      ["un", "", false],
      ["believ", "#ff0000", true],
      ["able", "", false],
      [" ", "", false],
      ["deal", "", false],
    ]);
  });

  it("shrinks every run in proportion to fit, and measures letter spacing as a plain text does", () => {
    const t = styleRange(text({ w: 80, h: 115, fit: "shrink" }), 0, 4, { size: 200 });
    const set = setRuns(t, measure);
    expect(set.scale).toBeLessThan(1);
    expect(set.lines.every((r) => r.width <= 80.5)).toBe(true);
    expect(set.lines.reduce((n, r) => n + r.height, 0)).toBeLessThanOrEqual(115.5);
    // spacing between the letters, not after the last: "Roll" at 10 a letter and 5 between
    expect(setRuns(text({ text: "Roll", spacing: 5, italic: true }), measure).lines[0]!.width).toBe(55);
  });

  it("keeps a styled text to a number of lines with no word alone on the last, as a plain text", () => {
    const six = (more: Partial<TextLayer>) => setRuns(text({ text: "aa bb cc dd ee ff", runs: [{ start: 0, end: 2, color: "#ff0000" }], h: 1000, lines: 2, ...more }), measure);
    expect(six({ w: 140 }).lines.map((l) => l.text)).toEqual(["aa bb cc dd", "ee ff"]);
    expect(six({ w: 140 }).size).toBe(100);
    const near = six({ w: 160 });
    expect(near.lines.map((l) => l.text)).toEqual(["aa bb cc dd ee ff"]);
    expect(near.size).toBeGreaterThanOrEqual(92);
    expect(near.size).toBeLessThan(95);
    expect(six({ w: 140, lines: undefined }).lines.map((l) => l.text)).toEqual(["aa bb cc dd ee", "ff"]);
    expect(six({ w: 100, lines: 1 }).lines).toHaveLength(1);
  });

  it("sets small capitals as capitals, smaller", () => {
    const [line] = setRuns(text({ text: "Roll", case: "small" }), measure).lines;
    expect(line!.pieces.map((p) => [p.text, p.size])).toEqual([
      ["R", 100],
      ["OLL", 72],
    ]);
  });

  it("puts a highlighter's stroke on each line at that line's size", () => {
    const boxes = markBoxes([{ color: "#f2b63c", words: "mat" }], ["Roll", "the mat"], [100, 200], [115, 230], 0, () => 0, (s) => s.length * 10);
    expect(boxes).toHaveLength(1);
    // on the second line, which starts 115 down, its stroke as tall as 200px letters need
    expect(boxes[0]!.y).toBeGreaterThan(115);
    expect(boxes[0]!.h).toBeCloseTo(200 * 0.72 + 200 * 0.1 + 200 * 0.2 + 200 * 0.1);
  });
});

describe("weights and slants of a font", () => {
  it("draws a weight in the family's face of it, never one made up, and leans a face with no italic over", () => {
    expect(weightsOf("Inter")).toEqual([700, 800]);
    expect(weightsOf("Poppins Regular")).toEqual([400, 700]);
    expect(weightsOf("Caveat")).toEqual([400, 500, 600, 700]);
    expect(weightsOf("Anton")).toEqual([400]);
    expect(faceOf("Inter", 800)).toEqual({ family: "Inter ExtraBold", css: 800, weight: 800, slant: false });
    expect(faceOf("Poppins Regular", 700).family).toBe("Poppins");
    // nearest: 900 in Montserrat is its ExtraBold; 400 in Oswald is its SemiBold
    expect(faceOf("Montserrat", 900).family).toBe("Montserrat ExtraBold");
    expect(faceOf("Oswald", 400).family).toBe("Oswald SemiBold");
    expect(faceOf("Caveat", 500)).toEqual({ family: "Caveat", css: 500, weight: 500, slant: false });
    // a text as it was before weights: its own font, at its own weight
    expect(faceOf("Caveat")).toMatchObject({ family: "Caveat", css: 700 });
    expect(faceOf("Montserrat SemiBold")).toMatchObject({ family: "Montserrat SemiBold", css: 600 });
    expect(faceOf("Inter", undefined, true).slant).toBe(true);
  });

  it("reads an own font's family, weight and slant from its name, and uses its own italic face", () => {
    expect(ownFace("Superclarendon Black Italic")).toEqual({ group: "superclarendon", weight: 900, italic: true });
    expect(ownFace("Superclarendon Extra Bold")).toEqual({ group: "superclarendon", weight: 800, italic: false });
    expect(ownFace("Superclarendon")).toEqual({ group: "superclarendon", weight: 400, italic: false });
    expect(ownFace("Bold")).toEqual({ group: "bold", weight: 400, italic: false });
    const own = ["Superclarendon", "Superclarendon Bold", "Superclarendon Italic", "Tiny Sans"];
    expect(facesOf("Superclarendon", own).map((f) => f.family)).toEqual(["Superclarendon", "Superclarendon Bold", "Superclarendon Italic"]);
    expect(faceOf("Superclarendon", 700, false, own)).toEqual({ family: "Superclarendon Bold", css: 400, weight: 700, slant: false });
    expect(faceOf("Superclarendon", undefined, true, own)).toMatchObject({ family: "Superclarendon Italic", slant: false });
    // bold italic asked, only a regular italic there: that italic, not a made-up one
    expect(faceOf("Superclarendon", 700, true, own)).toMatchObject({ family: "Superclarendon Italic", slant: false });
    // a text set in the italic face stays in it
    expect(faceOf("Superclarendon Italic", undefined, undefined, own).family).toBe("Superclarendon Italic");
    expect(weightsOf("Tiny Sans", own)).toEqual([400]);
  });
});
