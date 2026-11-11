import { describe, expect, it } from "vitest";
import type { Zoom } from "./screen-recording";
import { clock, dragTrim, dragZoom, rulerStep, zoomSlot } from "./screen-timeline";

const z = (start: number, end: number): Zoom => ({ start, end, x: 0.5, y: 0.5, scale: 2 });
const spans = (zooms: Zoom[]) => zooms.map((o) => [o.start, o.end]);

describe("screen timeline", () => {
  const zooms = [z(2, 5), z(7, 9), z(12, 14)];

  it("moves a zoom whole, as far as its neighbours and no further", () => {
    expect(spans(dragZoom(zooms, 1, "body", 1, 15))).toEqual([[2, 5], [8, 10], [12, 14]]);
    expect(spans(dragZoom(zooms, 1, "body", 30, 15))[1]).toEqual([10, 12]);
    expect(spans(dragZoom(zooms, 1, "body", -30, 15))[1]).toEqual([5, 7]);
    expect(spans(dragZoom(zooms, 2, "body", 30, 15))[2]).toEqual([13, 15]); // the end of the recording
    expect(spans(dragZoom(zooms, 0, "body", -30, 15))[0]).toEqual([0, 3]);
  });

  it("moves one end, never past the neighbour and never under the shortest zoom", () => {
    expect(spans(dragZoom(zooms, 1, "end", 2, 15))[1]).toEqual([7, 11]);
    expect(spans(dragZoom(zooms, 1, "end", 30, 15))[1]).toEqual([7, 12]);
    expect(spans(dragZoom(zooms, 1, "end", -30, 15))[1]).toEqual([7, 7.6]);
    expect(spans(dragZoom(zooms, 1, "start", -30, 15))[1]).toEqual([5, 9]);
    expect(spans(dragZoom(zooms, 1, "start", 30, 15))[1]).toEqual([8.4, 9]);
    expect(dragZoom(zooms, 9, "body", 1, 15)).toBe(zooms);
  });

  it("finds the room for a new zoom", () => {
    expect(zoomSlot([], 6, 15)).toEqual({ start: 4.5, end: 7.5 }); // centred under the press
    expect(zoomSlot([], 6, 15, "start")).toEqual({ start: 6, end: 9 }); // from the playhead
    expect(zoomSlot([], 14.5, 15, "start")).toEqual({ start: 12, end: 15 });
    expect(zoomSlot(zooms, 6, 15)).toEqual({ start: 5, end: 7 }); // the 2 s between two zooms
    expect(zoomSlot(zooms, 3, 15)).toBeNull(); // inside one
    expect(zoomSlot([z(2, 5), z(5.4, 9)], 5.2, 15)).toBeNull(); // too small a gap
    expect(zoomSlot([], 0.2, 0.5)).toBeNull(); // too short a recording
  });

  it("drags the ends of the kept part, keeping half a second", () => {
    expect(dragTrim({ start: 0, end: 15 }, "start", 4, 15)).toEqual({ start: 4, end: 15 });
    expect(dragTrim({ start: 4, end: 15 }, "end", 2, 15)).toEqual({ start: 4, end: 4.5 });
    expect(dragTrim({ start: 4, end: 15 }, "start", 99, 15)).toEqual({ start: 14.5, end: 15 });
    expect(dragTrim({ start: 4, end: 9 }, "end", 99, 15)).toEqual({ start: 4, end: 15 });
  });

  it("spaces the ruler's marks and writes the clock", () => {
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(420)).toBe(0.2);
    expect(rulerStep(1.2)).toBe(60);
    expect(clock(75)).toBe("1:15");
    expect(clock(3.49, true)).toBe("0:03.4");
    expect(clock(-1)).toBe("0:00");
  });
});
