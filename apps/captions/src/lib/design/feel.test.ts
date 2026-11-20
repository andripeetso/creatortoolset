import { describe, expect, it } from "vitest";
import { dupStep, edgePan, edgeSpeed, evenGap, FIT_PAD, scrubBy, SNAP_PX, tidy, turnTo } from "./feel";
import { fitView, snapMove } from "./hands";

const sq = (x: number, y: number, w = 50, h = 50) => ({ x, y, w, h });
const xs = (r: { x: number }[] | null) => r?.map((b) => b.x);

describe("how the canvas moves under the hand", () => {
  it("catches a line 4.5 screen pixels away, at any zoom, and not 5", () => {
    for (const z of [1, 2]) {
      expect(snapMove(sq(4 / z, 0), [sq(0, 200)], SNAP_PX / z).x).toBe(0);
      expect(snapMove(sq(5 / z, 0), [sq(0, 200)], SNAP_PX / z).x).toBeUndefined();
    }
  });

  it("steps a number half a unit a pixel dragged on its label, ten times with Shift, a tenth with Alt", () => {
    expect(Math.round(100 + scrubBy(12.2, 0.5))).toBe(106);
    expect(Math.round(100 + scrubBy(61.2, 0.5))).toBe(131);
    // opacity: 0.4 a pixel
    expect(Math.round(100 + scrubBy(-12.2, 0.4))).toBe(95);
    expect(scrubBy(10, 0.5, { shift: true })).toBe(50);
    expect(scrubBy(10, 0.5, { alt: true })).toBeCloseTo(0.5);
  });

  it("runs the view on near the edge: none 15 px in, 40 more a pixel nearer, 600 at most", () => {
    expect([40, 25, 15].map(edgeSpeed)).toEqual([0, 0, 0]);
    expect(edgeSpeed(12)).toBe(120);
    expect(edgeSpeed(8)).toBe(280);
    expect(edgeSpeed(2)).toBe(520);
    expect(edgeSpeed(0)).toBe(600);
    expect(edgeSpeed(-30)).toBe(600);
    // toward the edge the pointer is near: at the left edge the view's offset grows, so more of the left shows
    expect(edgePan(2, 300, 1000, 800)).toEqual({ x: 520, y: 0 });
    expect(edgePan(998, 798, 1000, 800)).toEqual({ x: -520, y: -520 });
  });

  it("turns with Shift to the nearest 15° on the page, not 15° steps from where it started", () => {
    expect(turnTo(7, 30, true)).toBe(30);
    expect(turnTo(7, 30, false)).toBe(37);
    expect(turnTo(10, 12, true)).toBe(15);
    expect(turnTo(170, 20, false)).toBe(-170);
  });

  it("zooms to the picked with 40 px above it and room for the tools below, as measured", () => {
    // a 10 by 10 layer in a 1389 by 903 canvas: 7630 %, 40 px above, 100 below
    const v = fitView(sq(0, 0, 10, 10), { w: 1389, h: 903 }, FIT_PAD);
    expect(v.z).toBeCloseTo(76.3);
    expect(v.y).toBeCloseTo(40);
    expect(903 - (v.y + 10 * v.z)).toBeCloseTo(100);
  });

  it("repeats a duplicate's move and its turn, the turn only when every copy took the same", () => {
    expect(dupStep([{ ...sq(0, 0), rotate: 0 }], [{ ...sq(150, 0), rotate: -15 }])).toEqual({ dx: 150, dy: 0, turn: -15 });
    expect(dupStep([sq(0, 0), sq(100, 0)], [{ ...sq(10, 5), rotate: 5 }, sq(110, 5)])).toEqual({ dx: 10, dy: 5, turn: 0 });
    expect(dupStep([], [])).toEqual({ dx: 0, dy: 0, turn: 0 });
  });
});

describe("tidy up", () => {
  it("evens the gaps to the commonest one, the smaller on a tie, else the mean rounded half up", () => {
    expect(evenGap([30, 40, 30])).toBe(30);
    expect(evenGap([10, 10, 70])).toBe(10);
    expect(evenGap([10, 25, 30])).toBe(22);
    expect(evenGap([10, 25])).toBe(18);
    expect(evenGap([20, 20, 40, 40])).toBe(20);
  });

  it("keeps a row's order, sizes and first place, and evens its gaps", () => {
    expect(xs(tidy([sq(0, 0), sq(60, 0), sq(135, 0), sq(215, 0)]))).toEqual([0, 72, 144, 216]);
    expect(xs(tidy([sq(0, 0), sq(60, 0), sq(135, 0)]))).toEqual([0, 68, 136]);
    // given out of order, each keeps its own place in the row
    expect(xs(tidy([sq(135, 0), sq(0, 0), sq(60, 0)]))).toEqual([136, 0, 68]);
    // a pair lying on each other in the row: their overlap counts in the mean
    expect(xs(tidy([sq(0, 0), sq(60, 0), sq(105, 0), sq(170, 0)]))).toEqual([0, 57, 114, 171]);
  });

  it("tidies a column the same way, the other axis kept", () => {
    const got = tidy([sq(5, 0, 50, 20), sq(9, 30, 50, 40), sq(2, 100, 50, 10)]);
    expect(got?.map((b) => [b.x, b.y])).toEqual([[5, 0], [9, 40], [2, 100]]);
    expect(tidy([sq(0, 0), sq(0, 70), sq(0, 130)])?.map((b) => b.y)).toEqual([0, 65, 130]);
  });

  it("packs a full grid along the direction with more lines, each line centred", () => {
    // two rows of three: columns 35 apart (gaps 30 and 40), each stacked 20 apart
    const got = tidy([sq(0, 0), sq(90, 0, 30, 50), sq(170, 0), sq(0, 70), sq(80, 70), sq(170, 70)]);
    expect(got?.map((b) => [b.x, b.y])).toEqual([[0, 0], [95, 0], [170, 0], [0, 70], [85, 70], [170, 70]]);
  });

  it("does nothing with two, a diagonal, a jumble or a pile", () => {
    expect(tidy([sq(0, 0), sq(80, 0)])).toBeNull();
    expect(tidy([sq(0, 0), sq(60, 60), sq(120, 120)])).toBeNull();
    // a header above two side by side
    expect(tidy([sq(0, 0, 200, 40), sq(0, 60), sq(100, 60)])).toBeNull();
    expect(tidy([sq(0, 0), sq(10, 10), sq(20, 20)])).toBeNull();
  });
});
