import { describe, expect, it } from "vitest";
import type { DesignPage, Layer } from "@contracts/design";
import { drawingUrl, fontOf, inLayer, keptOr, layerAt, lineHeightOf, setText, setTextOnce, shapePoints, shownText, sourceOf, textWidth, wrapLines } from "./draw";

/** Every letter 10 wide: widths a test can count. */
const measure = (s: string) => s.length * 10;
const box = (more: Partial<Layer> = {}): Layer => ({ id: "a", type: "shape", shape: "rect", fill: "#000000", x: 100, y: 100, w: 200, h: 100, ...more }) as Layer;

describe("drawing a design", () => {
  it("wraps between words inside the box, keeps the text's own line breaks, and leaves a word wider than the box whole", () => {
    expect(wrapLines("Roll the mat out", 80, measure)).toEqual(["Roll the", "mat out"]);
    expect(wrapLines("Roll the mat out", 1000, measure)).toEqual(["Roll the mat out"]);
    expect(wrapLines("One\n\nTwo  three", 1000, measure)).toEqual(["One", "", "Two three"]);
    expect(wrapLines("Supercalifragilistic mat", 50, measure)).toEqual(["Supercalifragilistic", "mat"]);
    expect(wrapLines("", 50, measure)).toEqual([""]);
  });

  it("measures a line with its letter spacing (between the letters, not after the last), so it wraps where it is drawn", () => {
    expect(textWidth({}, "Roll", measure)).toBe(40);
    expect(textWidth({ spacing: 5 }, "Roll", measure)).toBe(55);
    expect(textWidth({ spacing: 5 }, "", measure)).toBe(0);
    // an emoji is one letter
    expect(textWidth({ spacing: 5 }, "a👶", (s) => Array.from(s).length * 10)).toBe(25);
    const spaced = (s: string) => textWidth({ spacing: 10 }, s, measure);
    expect(wrapLines("Roll the mat", 120, measure)).toEqual(["Roll the mat"]);
    expect(wrapLines("Roll the mat", 120, spaced)).toEqual(["Roll", "the", "mat"]);
  });

  it("sets words in their box: at their own size, or shrunk to the largest size that fits, never under the smallest; balanced, in lines about as long as each other", () => {
    // every letter 10 wide at the layer's own size of 100, a line 115 high
    const words = (more: object) => ({ text: "Roll the mat out", size: 100, w: 100, h: 115, ...more });
    // its own size: it wraps where it wraps, whether it fits or not
    expect(setText(words({}), measure)).toEqual({ size: 100, lines: ["Roll the", "mat out"] });
    // shrunk: one line of 160 fits 100 wide at 62.5; two lines would need 50
    const shrunk = setText(words({ fit: "shrink" }), measure);
    expect(shrunk.lines).toEqual(["Roll the mat out"]);
    expect(shrunk.size).toBeGreaterThan(62);
    expect(shrunk.size).toBeLessThanOrEqual(62.5);
    // a box it fits already: its own size
    expect(setText(words({ fit: "shrink", w: 200, h: 115 }), measure).size).toBe(100);
    // a single word wider than the box shrinks until it fits (to half a pixel)
    const word = setText({ text: "Supercalifragilistic", size: 100, w: 100, h: 500, fit: "shrink" }, measure);
    expect(word.size).toBeGreaterThan(49.5);
    expect(word.size).toBeLessThanOrEqual(50.3);
    // a box nothing fits: the smallest size, not nothing
    expect(setText(words({ fit: "shrink", w: 5, h: 5 }), measure).size).toBe(8);
    // letter spacing does not shrink with the letters: on one line 15 gaps of 4 leave 40 for 160 of letters (size 25),
    // so two lines, as high as the box lets them be (60 / 2 / 1.15), are the larger
    const spaced = setText(words({ fit: "shrink", spacing: 4, h: 60 }), measure);
    expect(spaced.lines).toEqual(["Roll the mat", "out"]);
    expect(setText(words({ fit: "shrink", spacing: 4, h: 60, balance: true }), measure).lines).toEqual(["Roll the", "mat out"]);
    expect(spaced.size).toBeGreaterThan(25.9);
    expect(spaced.size).toBeLessThanOrEqual(26.4);
    // balanced: five words and one become three and three, in the same two lines; one line stays one line
    const six = { text: "aa bb cc dd ee ff", size: 100, w: 140, h: 500 };
    expect(setText(six, measure).lines).toEqual(["aa bb cc dd ee", "ff"]);
    expect(setText({ ...six, balance: true }, measure).lines).toEqual(["aa bb cc", "dd ee ff"]);
    expect(setText({ ...six, w: 400, balance: true }, measure).lines).toEqual(["aa bb cc dd ee ff"]);
    // a paragraph at a time: the text's own line breaks stay, and each paragraph that wraps is evened by itself
    expect(setText({ ...six, text: "aa bb cc dd ee ff\ngg\nhh ii jj kk ll mm", balance: true }, measure).lines).toEqual(["aa bb cc", "dd ee ff", "gg", "hh ii jj", "kk ll mm"]);
    // capitals are measured as they are drawn
    expect(setText({ text: "ab", upper: true, size: 100, w: 100, h: 500 }, (s) => (s === "AB" ? 30 : 999)).lines).toEqual(["AB"]);
  });

  it("sets a layer's words once: drawn again as it is, one string is measured; a font that arrived since, or a changed layer, sets it again", () => {
    const l = { id: "t", type: "text", text: "Roll the mat out and then the ramp", font: "Anton", size: 100, color: "#111111", align: "left", x: 0, y: 0, w: 120, h: 115, fit: "shrink", balance: true } as const;
    let calls = 0;
    let letter = 10;
    const counted = (s: string) => (calls++, s.length * letter);
    const first = setTextOnce(l, counted);
    const cost = calls;
    expect(cost).toBeGreaterThan(50);
    calls = 0;
    expect(setTextOnce(l, counted)).toBe(first);
    expect(calls).toBe(1);
    // its font arrived: every letter is narrower now, so it is set again, larger
    letter = 5;
    const again = setTextOnce(l, counted);
    expect(again.size).toBeGreaterThan(first.size);
    // the same words in another layer (the one a change made) are that layer's own
    calls = 0;
    setTextOnce({ ...l }, counted);
    expect(calls).toBeGreaterThan(50);
  });

  it("gives the shapes with straight sides their corners inside the box: a triangle up, an arrow to the right, a five-pointed star", () => {
    expect(shapePoints("triangle", 200, 100)).toEqual([[100, 0], [200, 100], [0, 100]]);
    const arrow = shapePoints("arrow", 300, 100);
    expect(arrow[3]).toEqual([300, 50]);
    expect(arrow[2]).toEqual([200, 0]);
    // a short arrow's head is at most half of it
    expect(shapePoints("arrow", 100, 100)[2]).toEqual([50, 0]);
    const star = shapePoints("star", 200, 200);
    expect(star).toHaveLength(10);
    expect(star[0]![0]).toBeCloseTo(100);
    expect(star[0]![1]).toBeCloseTo(0);
    for (const [x, y] of star) expect(x >= 0 && x <= 200 && y >= 0 && y <= 200).toBe(true);
  });

  it("keeps what was made for a layer of a frame: two frames' layers of the same id are two places, and the ones used longest ago go when there are too many", () => {
    const kept = new Map<string, { key: string; size: number; made: string }>();
    let made = 0;
    const get = (place: string, key: string, size = 10, room = 100) => keptOr(kept, place, key, size, room, (old) => `${place}:${key}:${++made}${old ? " (from the old one)" : ""}`);
    // every frame's first layer is "l1": drawn twice, each is made once
    for (let n = 0; n < 2; n++) for (const frame of ["p1", "p2"]) get(`${frame}/l1`, "warm");
    expect(made).toBe(2);
    // a layer changed is made again, from the one it had; the other is not
    expect(get("p1/l1", "cool")).toBe("p1/l1:cool:3 (from the old one)");
    expect(get("p2/l1", "warm")).toBe("p2/l1:warm:2");
    // too many: the one used longest ago goes, the one just asked for never does
    get("p3/l1", "big", 85);
    expect([...kept.keys()]).toEqual(["p2/l1", "p3/l1"]);
    get("p4/l1", "huge", 500);
    expect([...kept.keys()]).toEqual(["p4/l1"]);
  });

  it("names a text's font at its real weight and size, its line height and its shown letters", () => {
    expect(fontOf({ font: "Montserrat ExtraBold", size: 96 })).toBe('800 96px "Montserrat ExtraBold"');
    expect(fontOf({ font: "Anton", size: 50 }, 0.5)).toBe('400 25px "Anton"');
    expect(lineHeightOf({ size: 100 })).toBeCloseTo(115);
    expect(lineHeightOf({ size: 100, lineHeight: 1.3 })).toBe(130);
    expect(shownText({ text: "Roll it", upper: true })).toBe("ROLL IT");
  });

  it("finds the topmost layer under a point, through a layer's rotation", () => {
    const under = box({ id: "under" });
    const over = box({ id: "over", x: 250, y: 150, w: 100, h: 100 });
    const page: DesignPage = { id: "p1", background: "#ffffff", layers: [under, over] };
    expect(layerAt(page, 120, 120)?.id).toBe("under");
    expect(layerAt(page, 280, 180)?.id).toBe("over");
    expect(layerAt(page, 10, 10)).toBeNull();
    // a 200 × 100 box turned a quarter: its corners are no longer in it, a point above its middle now is
    const turned = box({ rotate: 90 });
    expect(inLayer(turned, 105, 105).inside).toBe(false);
    expect(inLayer(turned, 200, 60).inside).toBe(true);
    expect(inLayer(box(), 200, 60).inside).toBe(false);
    const local = inLayer(box(), 150, 130);
    expect([local.x, local.y]).toEqual([50, 30]);
  });

  it("lets a press through a hidden or a locked layer to what is under it", () => {
    const page = (over: Partial<Layer>): DesignPage => ({ id: "p1", background: "#ffffff", layers: [box({ id: "under" }), box({ id: "over", ...over })] });
    expect(layerAt(page({}), 150, 150)?.id).toBe("over");
    expect(layerAt(page({ hidden: true }), 150, 150)?.id).toBe("under");
    expect(layerAt(page({ locked: true }), 150, 150)?.id).toBe("under");
  });

  it("names what a layer needs loaded: a picture's id, a drawing's markup as a picture address, nothing for words and shapes", () => {
    expect(sourceOf({ id: "i", type: "image", picture: "ab12cd34.jpg", fit: "cover", x: 0, y: 0, w: 1, h: 1 })).toBe("ab12cd34.jpg");
    expect(sourceOf(box())).toBeNull();
    expect(drawingUrl('<svg viewBox="0 0 1 1"><rect fill="#f90"/></svg>')).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%201%201%22%3E%3Crect%20fill%3D%22%23f90%22%2F%3E%3C%2Fsvg%3E");
  });
});
