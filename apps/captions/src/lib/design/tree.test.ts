import { describe, expect, it } from "vitest";
import type { DesignPage, GroupLayer, Layer } from "@contracts/design";
import { boundsOf, mergeFrames, resizeBox } from "./hands";
import { fitContents } from "./resize";
import { guessWidth, layoutLayers } from "./layout";
import { depthOf, dropInto, maskWithNext, seenBox, shapeBounds, everyLayer, freshLayerIds, hug, inFrame, inScope, moveInto, moveRow, reid, scopeLayers, scopeOf, unscope, unwrap, withScope, wrap } from "./tree";

const rect = (id: string, x: number, y: number, w = 20, h = 10, more: object = {}): Layer => ({ id, type: "shape", shape: "rect", fill: "#ff0000", x, y, w, h, ...more }) as Layer;
const group = (id: string, x: number, y: number, w: number, h: number, layers: Layer[], more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", x, y, w, h, layers, ...more });
const page = (layers: Layer[]): DesignPage => ({ id: "p1", x: 0, y: 0, w: 400, h: 400, background: "#ffffff", layers });
/** Where a layer lies on the frame, rounded: its box through every container round it. */
const onFrame = (layers: Layer[], id: string) => {
  const b = boundsOf([inFrame(layers, id)!]);
  return [b.x, b.y, b.w, b.h].map((n) => Math.round(n * 10) / 10);
};

describe("containers: layers that hold layers", () => {
  const tree = [rect("a", 0, 0), group("g", 100, 50, 60, 40, [rect("b", 0, 0), group("h", 20, 10, 40, 30, [rect("c", 5, 5)])])];

  it("finds a layer however deep, knows its container, and counts every layer and how deep they go", () => {
    expect(everyLayer(tree).map((l) => l.id)).toEqual(["a", "g", "b", "h", "c"]);
    expect(scopeOf(tree, ["c"])).toBe("h");
    expect(scopeOf(tree, ["a"])).toBeNull();
    expect(depthOf(tree)).toBe(2);
    // ids unique in the frame, however deep
    expect(freshLayerIds(tree, 2)).toEqual(["l6", "l7"]);
  });

  it("gives a container's layers as they lie in the frame and puts them back the same, through a turned and mirrored container", () => {
    expect(scopeLayers(tree, "h").map((l) => [l.x, l.y])).toEqual([[125, 65]]);
    const turned = [group("t", 100, 100, 100, 50, [rect("k", 10, 10, 20, 10)], { rotate: 90, flipX: true, box: true })];
    const seen = scopeLayers(turned, "t");
    // the container turned a quarter: its layer's middle turned about the container's middle, and its turn with it
    expect(seen[0]).toMatchObject({ rotate: 90, flipX: true });
    const back = withScope(turned, "t", seen);
    expect((back[0] as GroupLayer).layers[0]).toMatchObject({ x: 10, y: 10 });
    // moved 5 right on the frame: 5 along the container's own axis it is turned to
    const moved = withScope(turned, "t", [{ ...seen[0]!, x: seen[0]!.x + 5 }]);
    expect(onFrame(moved, "k")[0]).toBeCloseTo(onFrame(turned, "k")[0]! + 5, 1);
  });

  it("keeps a plain group to the box round its layers, its layers where they are on the frame; an empty one is gone, a box keeps its size", () => {
    const g = group("g", 100, 100, 999, 999, [rect("a", 10, 20), rect("b", 50, 60)]);
    const [h] = hug([g]) as GroupLayer[];
    expect([h!.x, h!.y, h!.w, h!.h]).toEqual([110, 120, 60, 50]);
    expect(onFrame([h!], "b")).toEqual([150, 160, 20, 10]);
    expect(hug([group("e", 0, 0, 10, 10, [])])).toEqual([]);
    const box = group("x", 0, 0, 300, 200, [rect("a", 10, 10)], { box: true });
    expect(hug([box])[0]).toBe(box);
    // a list with nothing to change is the same list
    const same = [h!];
    expect(hug(same)).toBe(same);
  });

  it("groups and ungroups the picked layers where they are on the screen, the group where the frontmost was", () => {
    const flat = [rect("a", 10, 10), rect("x", 200, 200), rect("b", 50, 40, 20, 10, { group: "old" })];
    const made = wrap(flat, ["a", "b"], "g")!;
    expect(made.map((l) => l.id)).toEqual(["x", "g"]);
    const g = made[1] as GroupLayer;
    expect([g.x, g.y, g.w, g.h]).toEqual([10, 10, 60, 40]);
    // the older shared name is left behind: the container is the group now
    expect(g.layers[1]).not.toHaveProperty("group");
    expect(onFrame(made, "b")).toEqual([50, 40, 20, 10]);
    // a frame round them: a box of its own
    expect(wrap(flat, ["a"], "f", true)![0]).toMatchObject({ type: "group", box: true, x: 10, y: 10, w: 20, h: 10 });
    // taken apart, in its place, each where it was; a faded group's fade kept by its layers
    const back = unwrap([{ ...g, opacity: 0.5 }, rect("y", 0, 0)], ["g"]);
    expect(back.map((l) => [l.id, l.x, l.y, l.opacity])).toEqual([["a", 10, 10, 0.5], ["b", 50, 40, 0.5], ["y", 0, 0, undefined]]);
    // a hidden, locked or blending group taken apart: its layers stay hidden, locked and blending
    const kept = unwrap([{ ...g, hidden: true, locked: true, blend: "multiply" }], ["g"]);
    expect(kept.map((l) => [l.hidden, l.locked, l.blend])).toEqual([[true, true, "multiply"], [true, true, "multiply"]]);
    // a turned group taken apart: its layers keep their place on the screen, turned as it was
    const turned = { ...g, rotate: 30 };
    const freed = unwrap([turned], ["g"]);
    expect(onFrame(freed, "b")).toEqual(onFrame([turned], "b"));
    expect(freed[1]!.rotate).toBe(30);
  });

  it("works on a frame inside an open container and puts the change back there (inScope, unscope)", () => {
    const p = page(tree);
    const open = inScope(p, "g");
    expect(open.layers.map((l) => l.id)).toEqual(["b", "h"]);
    const nudged = { ...open, layers: open.layers.map((l) => (l.id === "b" ? { ...l, x: l.x + 7 } : l)) };
    const [whole] = unscope([nudged], [p]);
    expect(whole).not.toHaveProperty("scope");
    // a frame new since (a copy made from an open container) is made whole too: it never keeps a scope
    expect(unscope([{ ...open, id: "p9" }], [p])[0]).not.toHaveProperty("scope");
    expect(onFrame(whole!.layers, "b")).toEqual([107, 50, 20, 10]);
    // the rest of the container stays where it was on the frame
    expect(onFrame(whole!.layers, "c")).toEqual(onFrame(tree, "c"));
  });

  it("gives every layer inside pasted containers an id the frame does not use", () => {
    const pasted = reid([group("g", 0, 0, 10, 10, [rect("a", 0, 0), rect("b", 0, 0)])], ["l9"], tree);
    const ids = everyLayer(pasted).map((l) => l.id);
    expect(ids[0]).toBe("l9");
    expect(new Set([...ids, ...everyLayer(tree).map((l) => l.id)]).size).toBe(ids.length + 5);
  });

  it("moves a row of the layers list beside another, into a container and out of it, where it is on the frame; never into itself or too deep", () => {
    const p = page(tree);
    const intoH = moveRow(p, "a", "h", "into")!;
    expect(scopeOf(intoH.layers, ["a"])).toBe("h");
    expect(onFrame(intoH.layers, "a")).toEqual([0, 0, 20, 10]);
    const out = moveRow(intoH, "c", "a", "front")!;
    expect(scopeOf(out.layers, ["c"])).toBe("h");
    const top = moveRow(p, "c", "a", "behind")!;
    expect(top.layers.map((l) => l.id)).toEqual(["c", "a", "g"]);
    expect(onFrame(top.layers, "c")).toEqual(onFrame(tree, "c"));
    // h held only c: left empty, the plain group is gone
    expect(everyLayer(top.layers).some((l) => l.id === "h")).toBe(false);
    expect(moveRow(p, "g", "c", "behind")).toBeNull();
    const deep = page([group("d1", 0, 0, 10, 10, [group("d2", 0, 0, 10, 10, [group("d3", 0, 0, 10, 10, [group("d4", 0, 0, 10, 10, [rect("z", 0, 0)], { box: true })], { box: true })], { box: true })], { box: true }), group("x", 0, 0, 5, 5, [rect("y", 0, 0)])]);
    expect(moveRow(deep, "x", "d4", "into")).toBeNull();
  });

  it("drops dragged layers into the frame-like container under them, and out of the one they were in once they leave it", () => {
    const card = group("card", 100, 100, 200, 100, [rect("t", 10, 10)], { box: true });
    const loose = [card, rect("s", 0, 0), group("plain", 300, 300, 20, 10, [rect("q", 0, 0)])];
    expect(dropInto(loose, ["s"], { x: 150, y: 150 }, null, 4)).toBe("card");
    // a plain group takes nothing by a drag
    expect(dropInto(loose, ["s"], { x: 305, y: 305 }, null, 4)).toBeNull();
    // let go outside the card it was in: out to the frame
    expect(dropInto(loose, ["t"], { x: 10, y: 10 }, "card", 4)).toBeNull();
    expect(dropInto(loose, ["t"], { x: 150, y: 150 }, "card", 4)).toBe("card");
    // something bigger than the box (a background nudged under it) never goes into it
    expect(dropInto([card, rect("bg", 0, 0, 1080, 1350)], ["bg"], { x: 150, y: 150 }, null, 4)).toBeNull();
    const moved = moveInto(loose, ["s"], "card");
    expect(scopeOf(moved, ["s"])).toBe("card");
    expect(onFrame(moved, "s")).toEqual([0, 0, 20, 10]);
  });

  it("resizes a container with its layers: a plain group's grow with it, a box's follow its edges by their pins", () => {
    const g = group("g", 0, 0, 100, 50, [rect("a", 50, 0, 50, 50)]);
    const big = resizeBox(g, "e", 100, 0) as GroupLayer;
    expect(big.layers[0]).toMatchObject({ x: 100, w: 100 });
    const box = group("b", 0, 0, 100, 50, [rect("a", 80, 0, 20, 10, { pin: { x: "right" } }), rect("k", 0, 0, 20, 10)], { box: true });
    const wide = fitContents(box, { ...box, w: 200 });
    expect(wide.layers.map((l) => l.x)).toEqual([180, 0]);
  });

  it("keeps an edit made inside a container in this window when the server's copy changed another frame meanwhile", () => {
    const base = [page(tree), { ...page([]), id: "p2" }];
    const mine = [{ ...base[0]!, layers: withScope(base[0]!.layers, "h", [{ ...scopeLayers(base[0]!.layers, "h")[0]!, x: 300 }]) }, base[1]!];
    const theirs = [base[0]!, { ...base[1]!, name: "Renamed" }];
    const merged = mergeFrames(mine, base, theirs);
    expect(onFrame(merged[0]!.layers, "c")[0]).toBe(300);
    expect(merged[1]!.name).toBe("Renamed");
  });
});

describe("a boolean group's box", () => {
  const a = rect("a", 0, 0, 100, 100);
  const b = rect("b", 60, 40, 100, 100);
  it("is its shape's: the bottom layer's for subtract, the overlap for intersect, all of them else", () => {
    expect(shapeBounds(group("g", 0, 0, 1, 1, [a, b], { boolean: "subtract" }))).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(shapeBounds(group("g", 0, 0, 1, 1, [a, b], { boolean: "intersect" }))).toEqual({ x: 60, y: 40, w: 40, h: 60 });
    expect(shapeBounds(group("g", 0, 0, 1, 1, [a, b], { boolean: "exclude" }))).toEqual({ x: 0, y: 0, w: 160, h: 140 });
    // nothing overlaps: a pixel, never no size; a hidden layer is not in the shape
    expect(shapeBounds(group("g", 0, 0, 1, 1, [a, rect("c", 300, 300)], { boolean: "intersect" }))).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(shapeBounds(group("g", 0, 0, 1, 1, [{ ...a, hidden: true }, b], { boolean: "subtract" }))).toEqual({ x: 60, y: 40, w: 100, h: 100 });
  });
  it("is hugged as it is drawn: its layers keep their place on the frame", () => {
    const [g] = hug([group("g", 10, 10, 500, 500, [a, b], { boolean: "subtract" })]) as GroupLayer[];
    expect([g!.x, g!.y, g!.w, g!.h, g!.layers[1]!.x]).toEqual([10, 10, 100, 100, 60]);
  });
});

describe("masks in a list", () => {
  const mask = rect("m", 10, 10, 30, 30, { mask: "alpha" });
  const photo = rect("ph", 0, 0, 200, 100);
  it("ungrouped, a mask stays a mask only when nothing comes after its group", () => {
    const g = group("g", 0, 0, 200, 100, [mask, photo]);
    const after = unwrap([rect("bg", 0, 0, 400, 400), g, rect("title", 0, 0, 50, 20)], ["g"]);
    expect(after.map((l) => [l.id, l.mask])).toEqual([["bg", undefined], ["m", undefined], ["ph", undefined], ["title", undefined]]);
    expect(unwrap([rect("bg", 0, 0, 400, 400), g], ["g"]).map((l) => [l.id, l.mask])).toEqual([["bg", undefined], ["m", "alpha"], ["ph", undefined]]);
  });
  it("a group with a mask at the bottom hugs the mask; a masked layer is seen in the mask's box", () => {
    expect(shapeBounds(group("g", 0, 0, 1, 1, [mask, photo]))).toEqual({ x: 10, y: 10, w: 30, h: 30 });
    expect(seenBox([mask, photo], photo)).toEqual({ x: 10, y: 10, w: 30, h: 30 });
    expect(seenBox([photo], photo)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
  it("made a mask in an auto layout box, it is grouped with the layer above it: one place in the flow, the photo still over it", () => {
    const word = rect("w", 0, 0, 100, 40);
    const pic = rect("p", 120, 0, 100, 40);
    const row = group("row", 0, 0, 300, 40, [word, pic, rect("x", 240, 0, 40, 40)], { box: true, layout: { dir: "row", gap: 20 } });
    const next = maskWithNext(row.layers, "w", "mg")!;
    expect(next.map((l) => l.id)).toEqual(["mg", "x"]);
    const mg = next[0] as GroupLayer;
    expect(mg.layers.map((l) => [l.id, l.mask])).toEqual([["w", "alpha"], ["p", undefined]]);
    const laid = layoutLayers([{ ...row, layers: next }], guessWidth)[0] as GroupLayer;
    const inner = (laid.layers[0] as GroupLayer).layers;
    // the photo still lies where the word does relative to it, inside one place of the row
    expect(inner[1]!.x - inner[0]!.x).toBe(120);
    expect(maskWithNext(row.layers, "x", "mg")).toBeNull();
  });
});
