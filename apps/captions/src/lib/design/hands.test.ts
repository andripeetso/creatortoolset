import { describe, expect, it } from "vitest";
import type { DesignPage, Layer } from "@contracts/design";
import { alignLayers, boundsOf, distribute, fitView, freshIds, layerName, pageLeft, PAGE_GAP, resizeAll, resizeBox, snapMove, zoomAt, ZOOM } from "./hands";

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

  it("fits a box whole in the middle of the room, and lays the pages in a row", () => {
    const v = fitView({ x: 1200, y: 0, w: 1080, h: 1350 }, { w: 1000, h: 800 }, 50);
    expect(v.z).toBeCloseTo(700 / 1350);
    expect(v.x + (1200 + 540) * v.z).toBeCloseTo(500);
    expect(v.y + 675 * v.z).toBeCloseTo(400);
    expect([pageLeft(0, 1080), pageLeft(2, 1080)]).toEqual([0, 2 * (1080 + PAGE_GAP)]);
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
