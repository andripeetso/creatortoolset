import { describe, expect, it } from "vitest";
import { DESIGN_LIMITS, type DesignPage, type ImageLayer, type SplitAnswer, type TextLayer } from "@contracts/design";
import { SPLIT_FONTS, splitLayers } from "./split";

// what a Mac read on a drawn 1080 × 1350 slide: a two-line heading, a two-line line under it in yellow, and a sticker's words
const px = (x: number, y: number, w: number, h: number) => ({ x: x / 1080, y: y / 1350, w: w / 1080, h: h / 1350 });
const answer: SplitAnswer = {
  background: "bbbbbbbb.png",
  pieces: [{ ...px(400, 900, 300, 300), picture: "cccccccc.png" }],
  lines: [
    { text: "Floor first.", color: "#ffffff", ink: 0.4, ...px(87, 224, 726, 124) },
    { text: "Then sitting.", color: "#ffffff", ink: 0.4, ...px(86, 377, 856, 134) },
    { text: "Start low and build up slowly,", color: "#f5c542", ink: 0.2, ...px(90, 586, 616, 50) },
    { text: "not all in one go.", color: "#f5c542", ink: 0.2, ...px(90, 644, 484, 50) },
    { text: "3 tips", color: "#1d2a5c", ink: 0.35, ...px(784, 1078, 150, 56) },
  ],
};
const picture: ImageLayer = { id: "l1", type: "image", picture: "aaaaaaaa.png", fit: "cover", x: 0, y: 0, w: 1080, h: 1350 };
const page = (layers = [picture] as DesignPage["layers"]): DesignPage => ({ id: "p1", background: "#ffffff", layers, x: 0, y: 0, w: 1080, h: 1350 }) as DesignPage;
const texts = (p: DesignPage) => p.layers.filter((l): l is TextLayer => l.type === "text");

describe("a picture split into layers", () => {
  it("keeps the picture hidden, lays what is behind it the same way, and its lines as paragraphs where they were", () => {
    const out = splitLayers(page(), "l1", { width: 2048, height: 2560 }, answer);
    expect(out.layers.map((l) => [l.type, l.name ?? (l.type === "text" ? l.text : ""), !!l.hidden])).toEqual([
      ["image", "Original", true],
      ["image", "Background", false],
      ["image", "Piece 1", false],
      ["text", "Floor first.\nThen sitting.", false],
      ["text", "Start low and build up slowly,\nnot all in one go.", false],
      ["text", "3 tips", false],
    ]);
    expect(out.layers[1]).toMatchObject({ type: "image", picture: "bbbbbbbb.png", fit: "cover", x: 0, y: 0, w: 1080, h: 1350 });
    expect(out.layers[2]).toMatchObject({ picture: "cccccccc.png", fit: "contain", x: 400, y: 900, w: 300, h: 300 });
    const [head, under, sticker] = texts(out);
    // heavy letters bold, light ones regular; sizes from the boxes; the lines as far apart as they were
    expect([head!.font, under!.font, sticker!.font]).toEqual([SPLIT_FONTS.bold, SPLIT_FONTS.regular, SPLIT_FONTS.bold]);
    expect(head!.size).toBeGreaterThan(120);
    expect(head!.size).toBeLessThan(135);
    expect(head!.lineHeight! * head!.size).toBeCloseTo(153, -1);
    expect(head).toMatchObject({ align: "left", x: 86, color: "#ffffff", fit: "shrink" });
    // the first line's baseline where the picture had it (drawn at 330)
    const lh = head!.size * head!.lineHeight!;
    expect(head!.y + (lh - head!.size) / 2 + 0.8 * head!.size).toBeGreaterThan(322);
    expect(head!.y + (lh - head!.size) / 2 + 0.8 * head!.size).toBeLessThan(338);
    expect(under!.color).toBe("#f5c542");
  });

  it("puts each part where the picture shows it: in a smaller box, cut by cover, and turned with it", () => {
    // half the size, at 100, 50: the same slide drawn in a 540 × 675 box
    const small = splitLayers(page([{ ...picture, x: 100, y: 50, w: 540, h: 675 }]), "l1", { width: 1080, height: 1350 }, answer);
    expect(small.layers[2]).toMatchObject({ x: 300, y: 500, w: 150, h: 150 });
    // a square box cuts the slide's top and bottom off: what lay there (the sticker) is left out
    const square = splitLayers(page([{ ...picture, w: 1080, h: 800 }]), "l1", { width: 1080, height: 1350 }, answer);
    expect(texts(square).map((t) => t.text)).toEqual(["Floor first.\nThen sitting.", "Start low and build up slowly,\nnot all in one go."]);
    // turned a quarter: the piece's middle goes round the box's middle, and it is turned too
    const turned = splitLayers(page([{ ...picture, rotate: 90 }]), "l1", { width: 1080, height: 1350 }, answer);
    expect(turned.layers[2]).toMatchObject({ x: 15, y: 535, rotate: 90 });
  });

  it("fills the frame up to its cap: the words first, then the biggest pieces, the original last", () => {
    const others = Array.from({ length: DESIGN_LIMITS.layers - 4 }, (_, n): ImageLayer => ({ ...picture, id: `o${n}` }));
    const full = splitLayers(page([...others, picture]), "l1", { width: 1080, height: 1350 }, answer);
    expect(full.layers).toHaveLength(DESIGN_LIMITS.layers);
    expect(full.layers.slice(others.length).map((l) => l.name ?? l.type)).toEqual(["Background", "text", "text", "text"]);
    // the other layers are as they were, and a layer that is no picture is not split
    expect(full.layers.slice(0, others.length)).toEqual(others);
    expect(splitLayers(page(), "nope", { width: 1, height: 1 }, answer)).toEqual(page());
  });
});
