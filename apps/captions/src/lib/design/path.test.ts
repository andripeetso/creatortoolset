import { describe, expect, it } from "vitest";
import type { PathLayer } from "@contracts/design";
import { dragHandle, fitPath, inPixels, onPath, pathBounds, pathHit, refit, segments, svgPath, toBox, toFrame, toggleSmooth, tracePath, type Anchor } from "./path";

const layer = (more: Partial<PathLayer> = {}): PathLayer => ({ id: "p", type: "path", x: 100, y: 50, w: 200, h: 100, points: [{ x: 0, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }], ...more });
/** What a canvas was told to draw. */
const recorded = (points: Anchor[], closed: boolean, w = 1, h = 1) => {
  const calls: string[] = [];
  const say = (name: string) => (...a: number[]) => void calls.push(`${name} ${a.map((n) => Math.round(n * 100) / 100).join(" ")}`.trim());
  tracePath({ moveTo: say("M"), lineTo: say("L"), bezierCurveTo: say("C"), closePath: say("Z") }, points, closed, w, h);
  return calls;
};

describe("a path's line", () => {
  it("runs anchor to anchor: straight where neither end has a handle, a curve where one has, and back to the start when closed", () => {
    const tri: Anchor[] = [{ x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 }];
    expect(recorded(tri, false)).toEqual(["M 0 100", "L 50 0", "L 100 100"]);
    expect(recorded(tri, true)).toEqual(["M 0 100", "L 50 0", "L 100 100", "L 0 100", "Z"]);
    expect(segments(tri, true)).toHaveLength(3);
    const curve: Anchor[] = [{ x: 0, y: 0, out: [30, 0] }, { x: 100, y: 100, in: [0, -40] }];
    expect(recorded(curve, false)).toEqual(["M 0 0", "C 30 0 100 60 100 100"]);
    // a layer's points are parts of its box: drawn times its width and height
    expect(recorded([{ x: 0, y: 1 }, { x: 0.5, y: 0, in: [-0.1, 0] }], false, 200, 100)).toEqual(["M 0 100", "C 0 100 80 0 100 0"]);
    expect(svgPath(tri, true, (x, y) => [x * 2, y + 1])).toBe("M 0 101 C 0 101 100 1 100 1 C 100 1 200 101 200 101 C 200 101 0 101 0 101 Z");
    expect(recorded([], true)).toEqual([]);
  });

  it("is boxed by the line itself: its anchors and where a curve swings out, not where its handles end", () => {
    expect(pathBounds([{ x: 10, y: 20 }, { x: 110, y: 70 }], false)).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    // an arch from (0, 0) to (100, 0) with both handles 100 up: it rises to 75, not to 100
    const arch = pathBounds([{ x: 0, y: 0, out: [0, -100] }, { x: 100, y: 0, in: [0, -100] }], false);
    expect([arch.x, arch.w]).toEqual([0, 100]);
    expect(arch.y).toBeCloseTo(-75);
    expect(arch.h).toBeCloseTo(75);
    // closed, the stretch back to the start counts too
    expect(pathBounds([{ x: 0, y: 0 }, { x: 100, y: 0, out: [0, 80] }, { x: 0, y: 0 }], true).h).toBeGreaterThan(20);
    expect(pathBounds([], false)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("is kept in parts of its box, there and back; a line with no height gets a box one pixel high", () => {
    const px: Anchor[] = [{ x: 40, y: 220 }, { x: 140, y: 20, in: [-50, 0], out: [50, 0] }, { x: 240, y: 220 }];
    const { box, points } = fitPath(px, false);
    expect(box).toEqual({ x: 40, y: 20, w: 200, h: 200 });
    expect(points).toEqual([{ x: 0, y: 1 }, { x: 0.5, y: 0, in: [-0.25, 0], out: [0.25, 0] }, { x: 1, y: 1 }]);
    expect(inPixels({ points, w: 200, h: 200 })).toEqual(px.map((p) => ({ ...p, x: p.x - 40, y: p.y - 20 })));
    const flat = fitPath([{ x: 0, y: 7 }, { x: 80, y: 7 }], false);
    expect(flat.box).toEqual({ x: 0, y: 7, w: 80, h: 1 });
    expect(flat.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  });

  it("maps a point of the box to the frame and back, through the layer's rotation and flips", () => {
    const plain = layer();
    expect(toFrame(plain, 0, 0)).toEqual([100, 50]);
    expect(toBox(plain, 300, 150)).toEqual([200, 100]);
    // a quarter turn about the box's middle (200, 100): its top left corner goes to the top right of where it stood
    const turned = layer({ rotate: 90 });
    const [x, y] = toFrame(turned, 0, 0);
    expect([Math.round(x), Math.round(y) + 0]).toEqual([250, 0]);
    for (const l of [turned, layer({ rotate: 33, flipX: true }), layer({ flipY: true })]) {
      const [fx, fy] = toFrame(l, 30, 80);
      const [bx, by] = toBox(l, fx, fy);
      expect(bx).toBeCloseTo(30);
      expect(by).toBeCloseTo(80);
    }
    expect(toFrame(layer({ flipX: true }), 0, 0)).toEqual([300, 50]);
  });

  it("is refit after a change: the box close round the new line, and every point where it was on the canvas, turned or not", () => {
    for (const l of [layer(), layer({ rotate: 40 }), layer({ rotate: -120, flipX: true })]) {
      const px = inPixels(l);
      const where = (q: PathLayer) => inPixels(q).map((p) => toFrame(q, p.x, p.y));
      const was = where(l);
      // its top anchor pulled 60 up and 30 right
      const moved = px.map((p, n) => (n === 1 ? { ...p, x: p.x + 30, y: p.y - 60 } : p));
      const now = refit(l, moved);
      expect([now.w, now.h]).toEqual([200, 160]);
      const is = where(now);
      for (const n of [0, 2]) {
        expect(is[n]![0]).toBeCloseTo(was[n]![0], 1);
        expect(is[n]![1]).toBeCloseTo(was[n]![1], 1);
      }
      const [tx, ty] = toFrame(l, px[1]!.x + 30, px[1]!.y - 60);
      expect(is[1]![0]).toBeCloseTo(tx, 1);
      expect(is[1]![1]).toBeCloseTo(ty, 1);
      expect(now.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
    }
  });

  it("a handle dragged turns the one across from it to stay in line, at its own length; free, it leaves it", () => {
    const p: Anchor = { x: 0, y: 0, in: [-30, 0], out: [10, 0] };
    expect(dragHandle(p, "out", [0, 50])).toEqual({ x: 0, y: 0, in: [-0, -30], out: [0, 50] });
    expect(dragHandle(p, "out", [0, 50], true)).toEqual({ x: 0, y: 0, in: [-30, 0], out: [0, 50] });
    // nothing across from it: only the one moves
    expect(dragHandle({ x: 0, y: 0, out: [10, 0] }, "out", [20, 20])).toEqual({ x: 0, y: 0, out: [20, 20] });
  });

  it("an anchor is made smooth (handles along the line between its neighbours, a third of the way to each) or a corner again", () => {
    const tri: Anchor[] = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 300 }];
    const smooth = toggleSmooth(tri, 1, false);
    // its neighbours lie along (90, 300) from each other: unit direction (0.287, 0.958); 30 back, 100 on
    expect(smooth[1]!.in![0]).toBeCloseTo(-8.62, 1);
    expect(smooth[1]!.in![1]).toBeCloseTo(-28.73, 1);
    expect(smooth[1]!.out![0]).toBeCloseTo(28.73, 1);
    expect(smooth[1]!.out![1]).toBeCloseTo(95.78, 1);
    expect(toggleSmooth(smooth, 1, false)).toEqual(tri);
    // an end of an open line has one neighbour: it stays a corner; closed, the ends are neighbours
    expect(toggleSmooth(tri, 0, false)).toEqual(tri);
    expect(toggleSmooth(tri, 0, true)[0]!.out).toBeDefined();
  });

  it("is under the pointer on its line, and inside it when it is filled, not anywhere in the box round it", () => {
    // an open V in a 200 × 100 box at (100, 50): from its bottom left up to the top middle and down to the bottom right
    const open = layer({ stroke: { color: "#000000", width: 4 } });
    expect(onPath(open, 150, 100)).toBe(true); // half-way up its left stroke
    expect(onPath(open, 200, 140)).toBe(false); // the middle of the box, between the strokes
    expect(onPath(open, 200, 52)).toBe(true); // its tip
    expect(onPath(open, 90, 40)).toBe(false);
    // filled (and closed): the middle is in it, the box's top corners are not
    const filled = layer({ closed: true, fill: "#ff0000" });
    expect(onPath(filled, 200, 140)).toBe(true);
    expect(onPath(filled, 110, 60)).toBe(false);
    expect(onPath(filled, 290, 60)).toBe(false);
    // a wide line reaches as far as it is drawn; turned a half turn, the V points down and its tip is at the bottom
    expect(onPath(layer({ stroke: { color: "#000000", width: 60 } }), 150, 75)).toBe(true);
    expect(onPath(layer({ rotate: 180, stroke: { color: "#000000", width: 4 } }), 200, 148)).toBe(true);
    expect(onPath(layer({ rotate: 180, stroke: { color: "#000000", width: 4 } }), 200, 60)).toBe(false);
  });

  it("finds what the pointer is on: the picked anchor's handle ends before the anchors, each within reach", () => {
    const pts: Anchor[] = [{ x: 0, y: 0, out: [4, 0] }, { x: 100, y: 0 }];
    expect(pathHit(pts, null, 2, 1, 6)).toEqual({ anchor: 0 });
    expect(pathHit(pts, 0, 2, 1, 6)).toEqual({ anchor: 0, handle: "out" });
    expect(pathHit(pts, 0, 99, 3, 6)).toEqual({ anchor: 1 });
    expect(pathHit(pts, 0, 50, 50, 6)).toBeNull();
  });
});
