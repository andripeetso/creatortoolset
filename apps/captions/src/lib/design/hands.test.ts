import { describe, expect, it } from "vitest";
import type { DesignPage, Layer } from "@contracts/design";
import { DESIGN_GAP } from "@contracts/design";
import { dropTarget, paintedBox, withoutTyped, rehome, shownArea, groupName, alignLayers, besideFrames, boundsOf, boxPick, distribute, fitView, frameOf, freshIds, layerName, mergeFrame, mergeFrames, pageName, groupOf, freshGroup, hovers, hugLoose, regroup, snapSpacing, withGroups, resizeAll, resizeBox, snapMove, zoomAt, ZOOM } from "./hands";

const box = (x: number, y: number, w: number, h: number, rotate?: number) => ({ x, y, w, h, ...(rotate ? { rotate } : {}) });
/** A corner of a turned box on the page: (ux, uy) in half sizes from its middle. */
const corner = (l: { x: number; y: number; w: number; h: number; rotate?: number }, ux: number, uy: number) => {
  const a = ((l.rotate ?? 0) * Math.PI) / 180;
  return { x: l.x + l.w / 2 + (ux * l.w * Math.cos(a) - uy * l.h * Math.sin(a)) / 2, y: l.y + l.h / 2 + (ux * l.w * Math.sin(a) + uy * l.h * Math.cos(a)) / 2 };
};

describe("the hands on the canvas", () => {
  it("zooms about the pointer: the canvas point under it stays under it, inside the zoom's limits", () => {
    const v = { x: 40, y: -20, z: 0.5 };
    const under = (view: typeof v) => ({ x: (300 - view.x) / view.z, y: (200 - view.y) / view.z });
    const closer = zoomAt(v, 2, 300, 200);
    expect(closer.z).toBe(2);
    expect(under(closer).x).toBeCloseTo(under(v).x);
    expect(under(closer).y).toBeCloseTo(under(v).y);
    expect(zoomAt(v, 1000, 0, 0).z).toBe(ZOOM.max);
    expect(zoomAt(v, 0, 0, 0).z).toBe(ZOOM.min);
  });

  it("fits a box whole in the middle of the room", () => {
    const v = fitView({ x: 1200, y: 0, w: 1080, h: 1350 }, { w: 1000, h: 800 }, 50);
    expect(v.z).toBeCloseTo(700 / 1350);
    expect(v.x + (1200 + 540) * v.z).toBeCloseTo(500);
    expect(v.y + 675 * v.z).toBeCloseTo(400);
  });

  it("gives every frame its place and size: its own, or (one from before frames had any) its place in the row", () => {
    expect(frameOf({ x: -300, y: 40, w: 1280, h: 720 }, 3, 1080, 1350)).toEqual(box(-300, 40, 1280, 720));
    expect(frameOf({}, 2, 1080, 1350)).toEqual(box(2 * (1080 + DESIGN_GAP), 0, 1080, 1350));
    // a new frame goes beside the rightmost one, level with the frame it was made from
    expect(besideFrames([box(0, 0, 1080, 1350), box(2000, 500, 1280, 720)], box(0, 0, 1080, 1350), { w: 1080, h: 1080 })).toEqual(box(3280 + DESIGN_GAP, 0, 1080, 1080));
    expect(besideFrames([], undefined, { w: 100, h: 50 })).toEqual(box(0, 0, 100, 50));
    // the size may be a whole frame (a copy takes its original's): only its width and height are taken, never its place
    expect(besideFrames([box(0, 0, 1080, 1350), box(1200, 40, 600, 600)], box(1200, 40, 600, 600), box(1200, 40, 600, 600))).toEqual(box(1800 + DESIGN_GAP, 40, 600, 600));
    expect(pageName({ id: "p1", background: "#fff", layers: [] }, 1)).toBe("Frame 2");
  });

  it("groups: a layer picks its whole group, ids widen to whole groups, and layers coming into a frame keep to themselves", () => {
    const l = (id: string, group?: string): Layer => ({ id, type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w: 10, h: 10, ...(group ? { group } : {}) });
    const layers = [l("a", "g1"), l("b"), l("c", "g1"), l("d", "g2")];
    expect(groupOf(layers, layers[0]!)).toEqual(["a", "c"]);
    expect(groupOf(layers, layers[1]!)).toEqual(["b"]);
    expect(withGroups(layers, ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(withGroups(layers, ["b"])).toEqual(["b"]);
    expect(freshGroup(layers)).toBe("g3");
    expect(freshGroup(layers, ["g3"])).toBe("g4");
    // copies of a and c pasted into the same frame: a group of their own, not the one they were copied from
    const pasted = regroup([l("e", "g1"), l("f", "g1"), l("h")], layers);
    expect(pasted.map((x) => x.group)).toEqual(["g3", "g3", undefined]);
    // two groups coming in whose ids are both taken: each its own new one; a group whose id is free keeps it
    expect(regroup([l("e", "g1"), l("f", "g2"), l("h", "g9")], layers).map((x) => x.group)).toEqual(["g3", "g4", "g9"]);
    expect(regroup([l("e", "g1")], [l("z", "g7")])[0]!.group).toBe("g1");
  });

  it("catches a moving box on even spacing: between two neighbours, or beside one at the gap it keeps to the next, and says which gaps are then equal", () => {
    const a = box(0, 100, 100, 100);
    const b = box(300, 100, 100, 100);
    // between a and b there is 200 of room: a box 60 wide sits at 170, 70 from each
    expect(snapSpacing(box(166, 120, 60, 40), [a, b], 6, "x")).toEqual({ d: 4, gaps: [{ axis: "x", from: 100, to: 170, at: 140 }, { axis: "x", from: 230, to: 300, at: 140 }] });
    expect(snapSpacing(box(150, 120, 60, 40), [a, b], 6, "x")).toBeNull();
    // right of b, at the 200 that a keeps to b
    expect(snapSpacing(box(597, 100, 80, 80), [a, b], 6, "x")).toEqual({ d: 3, gaps: [{ axis: "x", from: 100, to: 300, at: 140 }, { axis: "x", from: 400, to: 600, at: 140 }] });
    // left of a likewise: its end 200 before a
    expect(snapSpacing(box(-282, 100, 80, 80), [a, b], 6, "x")?.d).toBe(2);
    // boxes it does not overlap across the axis are not beside it
    expect(snapSpacing(box(166, 400, 60, 40), [a, b], 6, "x")).toBeNull();
    // down the page the same, with the names of the sides swapped
    const top = box(50, 0, 100, 50);
    const low = box(50, 250, 100, 50);
    expect(snapSpacing(box(60, 123, 40, 50), [top, low], 6, "y")).toEqual({ d: 2, gaps: [{ axis: "y", from: 50, to: 125, at: 80 }, { axis: "y", from: 175, to: 250, at: 80 }] });
    // no room between them: nothing to catch on
    expect(snapSpacing(box(100, 100, 300, 40), [a, b], 6, "x")).toBeNull();
  });

  it("keeps both sides of a frame changed in two places: its place moved here, its layers designed there", () => {
    const l = (id: string, x: number): Layer => ({ id, type: "shape", shape: "rect", fill: "#000000", x, y: 0, w: 10, h: 10 });
    const base: DesignPage = { id: "p1", x: 0, y: 0, w: 1080, h: 1350, background: "#ffffff", layers: [l("l1", 0)] };
    const mine: DesignPage = { ...base, x: 900, y: -50 };
    const theirs: DesignPage = { ...base, background: "#111111", layers: [l("l1", 40), l("l2", 80)] };
    expect(mergeFrame(mine, base, theirs)).toEqual({ ...theirs, x: 900, y: -50 });
    // the same thing changed in both: this window's stays
    expect(mergeFrame({ ...base, layers: [l("l1", 7)] }, base, theirs).layers).toEqual([l("l1", 7)]);
    // a name taken off here stays off; a frame this window made (the server never had it) is this window's whole
    expect(mergeFrame({ ...base, name: undefined }, { ...base, name: "Cover" }, { ...theirs, name: "Cover" }).name).toBeUndefined();
    expect(mergeFrame(mine, undefined, theirs)).toBe(mine);
  });

  it("looks for a layer under the pointer only with the move tool, no button down and Space not held", () => {
    expect(hovers(0, "move", false)).toBe(true);
    expect(hovers(1, "move", false)).toBe(false);
    expect(hovers(4, "move", false)).toBe(false);
    expect(hovers(0, "rect", false)).toBe(false);
    expect(hovers(0, "move", true)).toBe(false);
  });

  it("keeps a frame's fills and lines changed here when the server changed something else, and any field frames get later", () => {
    const base: DesignPage = { id: "p1", x: 0, y: 0, w: 1080, h: 1350, background: "#ffffff", layers: [] };
    const theirs: DesignPage = { ...base, name: "From the server" };
    const fills: DesignPage["fills"] = [{ type: "solid", color: "#ff0000" }];
    const strokes: DesignPage["strokes"] = [{ color: "#000000", width: 4 }];
    const mine = { ...base, fills, strokes, later: 1 } as DesignPage;
    expect(mergeFrame(mine, base, theirs)).toEqual({ ...theirs, fills, strokes, later: 1 });
    // fills taken off here stay off; the id is always the server's frame
    expect(mergeFrame({ ...base, id: "p9" }, { ...base, fills }, { ...theirs, fills })).toEqual(theirs);
  });

  it("does this window's work again on the design as the server has it: frames made, deleted, moved and reordered here, beside what changed there", () => {
    const f = (id: string, more: Partial<DesignPage> = {}): DesignPage => ({ id, x: 0, y: 0, w: 100, h: 100, background: "#ffffff", layers: [], ...more });
    const base = [f("a"), f("b"), f("c")];
    const ids = (pages: DesignPage[]) => pages.map((p) => p.id).join();
    // there: b recoloured and a frame added. Here: a moved, c deleted, a frame made
    const theirs = [f("a"), f("b", { background: "#000000" }), f("c"), f("ai")];
    const merged = mergeFrames([f("a", { x: 500 }), base[1]!, f("new")], base, theirs);
    expect(ids(merged)).toBe("a,b,ai,new");
    expect([merged[0]!.x, merged[1]!.background]).toEqual([500, "#000000"]);
    // nothing done here: the server's, as it is (the very frames)
    expect(mergeFrames(base, base, theirs)).toEqual(theirs);
    // reordered here: this window's order, with the frame added there still in
    expect(ids(mergeFrames([base[2]!, base[0]!, base[1]!], base, theirs))).toBe("c,a,b,ai");
    // a frame deleted there is not brought back by a window that only still had it
    expect(ids(mergeFrames(base, base, [f("a"), f("c")]))).toBe("a,c");
  });

  it("resizes about the opposite corner, through the layer's rotation; Shift keeps the shape, Alt the middle", () => {
    expect(resizeBox(box(100, 100, 200, 100), "se", 50, 20)).toEqual(box(100, 100, 250, 120));
    expect(resizeBox(box(100, 100, 200, 100), "nw", 50, 20)).toEqual(box(150, 120, 150, 80));
    expect(resizeBox(box(100, 100, 200, 100), "e", 50, 999)).toEqual(box(100, 100, 250, 100));
    expect(resizeBox(box(100, 100, 200, 100), "w", 500, 0, { min: 8 })).toEqual(box(292, 100, 8, 100));
    expect(resizeBox(box(100, 100, 200, 100), "se", 100, 0, { keep: true })).toEqual(box(100, 100, 300, 150));
    expect(resizeBox(box(100, 100, 200, 100), "se", 20, 10, { center: true })).toEqual(box(80, 90, 240, 120));
    // turned 30°: the pointer pulls the bottom right corner, the top left one does not move on the page
    const was = box(100, 100, 200, 100, 30);
    const now = resizeBox(was, "se", 60, 45);
    expect(now.w).not.toBe(was.w);
    expect(corner(now, -1, -1).x).toBeCloseTo(corner(was, -1, -1).x, 1);
    expect(corner(now, -1, -1).y).toBeCloseTo(corner(was, -1, -1).y, 1);
    // a quarter turn: pulling its "east" handle down the page makes it wider
    expect(resizeBox(box(0, 0, 200, 100, 90), "e", 0, 40).w).toBe(240);
  });

  it("resizes several layers together, each keeping its share of the box round them", () => {
    const two = [box(0, 0, 100, 100), box(100, 100, 100, 100)];
    expect(boundsOf(two)).toEqual(box(0, 0, 200, 200));
    expect(resizeAll(two, box(0, 0, 200, 200), box(0, 0, 400, 100))).toEqual([box(0, 0, 200, 50), box(200, 50, 200, 50)]);
    // a quarter turn swaps the room a layer takes
    const turned = boundsOf([box(0, 0, 200, 100, 90)]);
    expect([turned.x, turned.y, turned.w, turned.h].map(Math.round)).toEqual([50, -50, 100, 200]);
  });

  it("catches a moving box on the nearest edge or middle within reach, and says where the guide is", () => {
    const page = box(0, 0, 1080, 1350);
    expect(snapMove(box(4, 300, 200, 100), [page], 6)).toEqual({ dx: -4, dy: 0, x: 0 });
    expect(snapMove(box(437, 622, 200, 100), [page], 6)).toEqual({ dx: 3, dy: 3, x: 540, y: 675 });
    expect(snapMove(box(300, 300, 200, 100), [page], 6)).toEqual({ dx: 0, dy: 0 });
    // another layer's right edge is nearer than the page's middle
    expect(snapMove(box(538, 300, 200, 100), [page, box(400, 0, 139, 50)], 6)).toMatchObject({ dx: 1, x: 539 });
  });

  it("lines one layer up with its page and several with each other, and spaces three out evenly", () => {
    const page = { w: 1000, h: 500 };
    expect(alignLayers([box(10, 10, 100, 50)], "center", page)).toEqual([box(450, 10, 100, 50)]);
    expect(alignLayers([box(10, 10, 100, 50)], "bottom", page)).toEqual([box(10, 450, 100, 50)]);
    expect(alignLayers([box(10, 10, 100, 50), box(300, 200, 50, 50)], "right", page)).toEqual([box(250, 10, 100, 50), box(300, 200, 50, 50)]);
    expect(alignLayers([box(10, 10, 100, 50), box(300, 200, 50, 50)], "top", page).map((l) => l.y)).toEqual([10, 10]);
    expect(distribute([box(0, 0, 100, 10), box(110, 0, 100, 10), box(500, 0, 100, 10)], "x").map((l) => l.x)).toEqual([0, 250, 500]);
    expect(distribute([box(0, 0, 100, 10), box(110, 0, 100, 10)], "x").map((l) => l.x)).toEqual([0, 110]);
  });

  it("gives ids a page does not have, and calls a layer by its name or by what it is", () => {
    const layers = [{ id: "l1" }, { id: "l3" }] as Layer[];
    expect(freshIds({ id: "p1", background: "#ffffff", layers } as DesignPage, 3)).toEqual(["l4", "l5", "l6"]);
    const shape = { id: "a", type: "shape", shape: "ellipse", fill: "#000000", x: 0, y: 0, w: 1, h: 1 } as Layer;
    expect(layerName(shape)).toBe("Ellipse");
    expect(layerName({ ...shape, name: "Sun" })).toBe("Sun");
    expect(layerName({ id: "t", type: "text", text: "Roll\nthe mat out", font: "Inter", size: 40, color: "#111111", align: "left", x: 0, y: 0, w: 1, h: 1 })).toBe("Roll the mat out");
  });
});

describe("what a box drawn across the canvas picks", () => {
  const shape = (id: string, x: number, y: number, more: Partial<Layer> = {}): Layer => ({ id, type: "shape", shape: "rect", fill: "#000000", x, y, w: 100, h: 100, ...more }) as Layer;
  // three frames in a row, 1000 wide, 200 apart: the first two with layers, the third empty
  const frames = [
    { rect: { x: 0, y: 0, w: 1000, h: 1000 }, layers: [shape("a", 100, 100), shape("b", 700, 700)] },
    { rect: { x: 1200, y: 0, w: 1000, h: 1000 }, layers: [shape("c", 50, 50), shape("gone", 400, 400, { hidden: true }), shape("held", 600, 600, { locked: true })] },
    { rect: { x: 2400, y: 0, w: 1000, h: 1000 }, layers: [] as Layer[] },
  ];
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it("a frame the box covers whole is picked itself, and every other frame the box touches with it", () => {
    expect(boxPick(frames, box(-50, -50, 1100, 1100), { home: -1 })).toEqual({ frames: [0] });
    expect(boxPick(frames, box(-50, -50, 2300, 1100), { home: -1 })).toEqual({ frames: [0, 1] });
    // the first whole, the second only touched: both are frames, the second is not opened
    expect(boxPick(frames, box(-50, -50, 1400, 1100), { home: -1 })).toEqual({ frames: [0, 1] });
  });
  it("a frame only partly in the box gives its layers the box touches, never a hidden or a locked one", () => {
    expect(boxPick(frames, box(-50, -50, 300, 300), { home: -1 })).toEqual({ at: 0, layers: ["a"] });
    expect(boxPick(frames, box(1100, -50, 900, 900), { home: -1 })).toEqual({ at: 1, layers: ["c"] });
    expect(boxPick(frames, box(1500, 300, 400, 400), { home: 1 })).toBeNull();
  });
  it("layers are of one frame: the one the box began on when it touches any there, else the first it touches any in", () => {
    const across = box(650, 0, 800, 900);
    expect(boxPick(frames, across, { home: 1 })).toEqual({ at: 1, layers: ["c"] });
    expect(boxPick(frames, across, { home: 0 })).toEqual({ at: 0, layers: ["b"] });
    expect(boxPick(frames, across, { home: -1 })).toEqual({ at: 0, layers: ["b"] });
  });
  it("an empty frame is picked as soon as the box touches it, and one with only locked or hidden layers too", () => {
    expect(boxPick(frames, box(2300, 400, 200, 200), { home: -1 })).toEqual({ frames: [2] });
    expect(boxPick([{ rect: frames[1]!.rect, layers: frames[1]!.layers.slice(1) }], box(1100, 400, 200, 200), { home: -1 })).toEqual({ frames: [0] });
  });
  it("with ⌘ a box never picks a frame: always the layers it touches", () => {
    expect(boxPick(frames, box(-50, -50, 1100, 1100), { home: -1, deep: true })).toEqual({ at: 0, layers: ["a", "b"] });
    expect(boxPick(frames, box(2300, 400, 200, 200), { home: -1, deep: true })).toBeNull();
  });
  it("a box on nothing picks nothing", () => {
    expect(boxPick(frames, box(0, 1500, 300, 300), { home: -1 })).toBeNull();
  });
});

describe("a group's own name", () => {
  it("is the name its maker gave it, as words; a group made by hand has none", () => {
    expect(groupName("palm-trees")).toBe("Palm trees");
    expect(groupName("sun")).toBe("Sun");
    expect(groupName("badge-2")).toBe("Badge 2");
    expect(groupName("g1")).toBeNull();
    expect(groupName("g27")).toBeNull();
    expect(groupName(undefined)).toBeNull();
    // a name that only starts like a hand-made one is a name
    expect(groupName("glow")).toBe("Glow");
  });

  it("keeps a loose picture's box round its picture, and lets one with nothing left go", () => {
    const pic: Layer = { id: "l1", type: "image", picture: "ab12cd34.jpg", fit: "cover", x: 30, y: -10, w: 100, h: 50 };
    const frame: DesignPage = { id: "f", x: 0, y: 0, w: 10, h: 10, background: "#ffffff", layers: [] };
    const loose: DesignPage = { id: "p", loose: true, x: 500, y: 500, w: 100, h: 50, background: "#ffffff", layers: [pic] };
    const [f, hugged] = hugLoose([frame, loose]);
    expect(f).toBe(frame);
    // the picture stays where it was on the canvas; the box comes to it
    expect(hugged).toMatchObject({ x: 530, y: 490, w: 100, h: 50, layers: [{ x: 0, y: 0, w: 100, h: 50 }] });
    // a turned picture: the box round its corners
    expect(hugLoose([{ ...loose, layers: [{ ...pic, x: 0, y: 0, w: 100, h: 100, rotate: 45 }] }])[0]).toMatchObject({ w: 142, h: 142, layers: [{ x: 21, y: 21 }] });
    const settled = [frame, { ...loose, layers: [{ ...pic, x: 0, y: 0 }] }];
    expect(hugLoose(settled)).toBe(settled);
    expect(hugLoose([frame, { ...loose, layers: [] }])).toEqual([frame]);
    expect(hugLoose([frame, { ...loose, layers: [] }], false)).toHaveLength(2);
  });

  it("lands dragged layers in the frame under their middle, loose once wholly off their own frame, else where they were", () => {
    const frames = [{ rect: { x: 0, y: 0, w: 100, h: 100 } }, { rect: { x: 200, y: 0, w: 100, h: 100 } }, { rect: { x: 400, y: 0, w: 50, h: 50 }, loose: true }];
    // over the other frame: that frame's; over a full one: back home
    expect(dropTarget(frames, 0, { x: 230, y: 30, w: 20, h: 20 })).toBe(1);
    expect(dropTarget([frames[0]!, { ...frames[1]!, full: true }], 0, { x: 230, y: 30, w: 20, h: 20 })).toBe(0);
    // half off its frame: still the frame's (shown past its edge when it does not clip)
    expect(dropTarget(frames, 0, { x: 90, y: 30, w: 30, h: 20 })).toBe(0);
    // wholly off, over empty canvas: loose
    expect(dropTarget(frames, 0, { x: 120, y: 30, w: 30, h: 20 })).toBe(-1);
    // a loose piece is no frame to land in: over one, layers off their frame still lie loose
    expect(dropTarget(frames, 0, { x: 410, y: 10, w: 10, h: 10 })).toBe(-1);
    // a loose piece's layers moved about the canvas stay in it; dropped on a frame they are that frame's
    expect(dropTarget(frames, 2, { x: 600, y: 600, w: 10, h: 10 })).toBe(2);
    expect(dropTarget(frames, 2, { x: 10, y: 10, w: 10, h: 10 })).toBe(0);
  });

  it("moves layers between a frame's pixels and the canvas's without moving them on the canvas", () => {
    const frame = { x: 500, y: -200 };
    const l = { x: 10, y: 20, w: 5, h: 5 };
    const onCanvas = rehome([l], frame, {})[0]!;
    expect(onCanvas).toMatchObject({ x: 510, y: -180, w: 5 });
    expect(rehome([onCanvas], {}, frame)[0]).toEqual(l);
    // frame to frame
    expect(rehome([l], frame, { x: 600, y: 0 })[0]).toMatchObject({ x: -90, y: -180 });
  });

  it("shows a frame that clips as itself, and one that does not with all its layers past its edges", () => {
    const frame: DesignPage = { id: "f", x: 0, y: 0, w: 100, h: 100, background: "#ffffff", layers: [{ id: "a", type: "shape", shape: "rect", fill: "#000000", x: -30, y: 80, w: 40, h: 50 }, { id: "b", type: "shape", shape: "rect", fill: "#000000", x: 500, y: 0, w: 10, h: 10, hidden: true }] };
    expect(shownArea(frame, 100, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(shownArea({ ...frame, clip: false }, 100, 100)).toEqual({ x: -30, y: 0, w: 130, h: 130 });
  });

  it("keeps any kind of layer lying loose, and a frame's clip, through a merge", () => {
    const words: Layer = { id: "t", type: "text", text: "Hi", font: "Inter", size: 20, color: "#111111", align: "left", x: 10, y: 10, w: 80, h: 30 };
    expect(hugLoose([{ id: "p", loose: true, x: 100, y: 100, w: 16, h: 16, background: "#ffffff", layers: [words] }])[0]).toMatchObject({ x: 110, y: 110, w: 80, h: 30, layers: [{ x: 0, y: 0 }] });
    const base: DesignPage = { id: "f", x: 0, y: 0, w: 100, h: 100, background: "#ffffff", layers: [] };
    expect(mergeFrame({ ...base, clip: false }, base, { ...base, background: "#000000" })).toMatchObject({ clip: false, background: "#000000" });
  });

  it("counts everything a layer paints past its box: a shadow where it falls, an outside line, a blur", () => {
    const star: Layer = { id: "s", type: "shape", shape: "star", fill: "#ff0000", x: 0, y: 0, w: 100, h: 100 };
    expect(paintedBox(star)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    // a soft shadow 20 down, blur 40: 60 round it, moved down 20
    expect(paintedBox({ ...star, effects: [{ type: "shadow", color: "#000000", opacity: 0.5, blur: 40, x: 0, y: 20 }] })).toEqual({ x: -60, y: -40, w: 220, h: 220 });
    // the old shadow field counts the same; a hidden effect not at all
    expect(paintedBox({ ...star, shadow: { color: "#000000", opacity: 0.5, blur: 40, x: 0, y: 20 } })).toEqual({ x: -60, y: -40, w: 220, h: 220 });
    expect(paintedBox({ ...star, effects: [{ type: "shadow", color: "#000000", opacity: 0.5, blur: 40, x: 0, y: 20, hidden: true }] })).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    // a line outside, 10 wide, and a blur of 10 (three times its size each way)
    expect(paintedBox({ ...star, strokes: [{ color: "#000000", width: 10, side: "outside" }] })).toEqual({ x: -10, y: -10, w: 120, h: 120 });
    expect(paintedBox({ ...star, effects: [{ type: "blur", blur: 10 }] })).toEqual({ x: -30, y: -30, w: 160, h: 160 });
  });

  it("shows a loose piece and an unclipped frame whole, with their shadows; a frame that clips as itself", () => {
    const shadowed: Layer = { id: "a", type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w: 50, h: 50, effects: [{ type: "shadow", color: "#000000", opacity: 1, blur: 20, x: 0, y: 0 }] };
    const piece: DesignPage = { id: "p", loose: true, x: 500, y: 500, w: 50, h: 50, background: "#ffffff", layers: [shadowed] };
    expect(shownArea(piece, 50, 50)).toEqual({ x: -30, y: -30, w: 110, h: 110 });
    const frame: DesignPage = { id: "f", x: 0, y: 0, w: 100, h: 100, background: "#ffffff", layers: [{ ...shadowed, x: 90 }] };
    expect(shownArea(frame, 100, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(shownArea({ ...frame, clip: false }, 100, 100)).toEqual({ x: 0, y: -30, w: 170, h: 130 });
  });

  it("a box drawn past an unclipped frame's edge picks its layers lying there, not the frame", () => {
    const out: Layer = { id: "o", type: "shape", shape: "rect", fill: "#000000", x: 150, y: 10, w: 30, h: 30 };
    const frame = { rect: { x: 0, y: 0, w: 100, h: 100 }, layers: [out] };
    const box = { x: 140, y: 0, w: 60, h: 60 };
    // (picked on another frame: this one is looked in only where the box touches it)
    expect(boxPick([frame], box, { home: -1 })).toBeNull();
    expect(boxPick([{ ...frame, reach: { x: 0, y: 0, w: 180, h: 100 } }], box, { home: -1 })).toEqual({ at: 0, layers: ["o"] });
  });
});

describe("lining up inside a container", () => {
  it("lines one layer up with the box it lies in when that box is given with its place", () => {
    const l = { x: 0, y: 0, w: 20, h: 10 };
    expect(alignLayers([l], "right", { x: 100, y: 50, w: 200, h: 100 })).toEqual([{ ...l, x: 280 }]);
    expect(alignLayers([l], "middle", { x: 100, y: 50, w: 200, h: 100 })).toEqual([{ ...l, y: 95 }]);
  });
});

describe("the words being typed", () => {
  const word = (id: string, more: object = {}) => ({ id, type: "text", text: "Hop", font: "Inter", size: 40, color: "#000000", align: "left", x: 0, y: 0, w: 100, h: 50, ...more }) as Layer;
  it("are left out of the drawing under the box they are typed in, but a mask's or a combined shape's part's", () => {
    expect(withoutTyped([word("a"), word("b")], "a").map((l) => l.id)).toEqual(["b"]);
    const masking = [word("a", { mask: "alpha" }), word("b")];
    expect(withoutTyped(masking, "a")).toBe(masking);
    const ring = [{ id: "g", type: "group", boolean: "subtract", x: 0, y: 0, w: 100, h: 50, layers: [word("a"), word("b")] } as Layer];
    expect(withoutTyped(ring, "b")).toBe(ring);
  });
});

it("a path's painted box reaches where its curve swings past its box", () => {
  const bulge = { id: "p", type: "path", x: 20, y: 30, w: 40, h: 20, closed: true, fill: "#000000", points: [{ x: 0, y: 1, out: [0, -2] }, { x: 1, y: 1, in: [0, -2] }] } as Layer;
  // the curve's top is half the height above the box
  expect(paintedBox(bulge)).toEqual({ x: 20, y: 20, w: 40, h: 30 });
});
