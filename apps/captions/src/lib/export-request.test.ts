import { expect, it } from "vitest";
import { exportName, renderSpecOf, storedRenderData } from "./export-request";
import { DEFAULT_STYLE, type Cue, type TextOverlay } from "./types";

it("names an export {project}_{clip}, and a clip already named after its project only once", () => {
  expect(exportName("Morning routine", "IMG_0042.MOV")).toBe("Morning_routine_IMG_0042");
  expect(exportName("tumbles.mp4", "tumbles.mp4")).toBe("tumbles");
  // the project was named after the clip, with spaces: not "Tiny_tumbles_Tiny tumbles"
  expect(exportName("Tiny tumbles", "Tiny tumbles.mp4")).toBe("Tiny tumbles");
  expect(exportName("Tiny tumbles", "Tiny tumbles take 2.mov")).toBe("Tiny tumbles take 2");
  expect(exportName("", "")).toBe("captions");
});

it("a stored clip renders from what the page holds for it: today's defaults for an old save, lines held to the next one when the look says so", () => {
  const word = { id: 1, text: "Tiny", start: 0.1, end: 0.4 };
  const cues: Cue[] = [
    { id: 1, start: 0.1, end: 0.4, words: [word] },
    { id: 2, start: 1, end: 1.2, words: [{ ...word, id: 2, start: 1, end: 1.2 }] },
  ];
  const text = { id: 1, text: "Hello", start: 0, end: 1, x: 50, y: 20, sizePct: 5, color: "#ffffff" } as TextOverlay;
  const plain = storedRenderData({ duration: 2.4, srcWidth: 1080, srcHeight: 1920, cues, style: { fontFamily: "Poppins" }, texts: [text] });
  expect(plain).toMatchObject({ cues, duration: 2.4, width: 1080, height: 1920, posSegments: [], style: { ...DEFAULT_STYLE, fontFamily: "Poppins", fitBox: true, lowercase: false } });
  expect(plain.texts).toEqual([{ ...text, w: 40, fontFamily: "Anton", outlineColor: "#000000", outlineWidth: 4, shadowDepth: 0, boxEnabled: false, boxColor: "#000000", rotation: 0 }]);
  const filled = storedRenderData({ duration: 2.4, srcWidth: 1080, srcHeight: 1920, cues, style: { fillGaps: true } });
  expect(filled.cues.map((q) => q.end)).toEqual([0.999, 2.4]);
  // nothing stored yet: empty lists, never undefined (the export route refuses a request without them)
  expect(renderSpecOf(storedRenderData({}))).toEqual({ width: 0, height: 0, cues: [], style: { ...DEFAULT_STYLE, fitBox: true, lowercase: false }, posSegments: [], texts: [] });
});
