import { describe, expect, it } from "vitest";
import { withKeys, type NleItem, type NleTimeline } from "./model";
import { stillCached } from "./cache";

// A Tiny Acrobatics talking head: three shots on V1, each with its voice on A1, all three in the render cache.
const shots: NleItem[] = [
  { src: "cam", rec: 0, len: 50, in: 0 },
  { src: "cam", rec: 50, len: 50, in: 100 },
  { src: "cam", rec: 100, len: 50, in: 200 },
];
const cut = (v1 = shots, more: Partial<NleTimeline> = {}): NleTimeline =>
  withKeys({
    timeline: { fps: 25, width: 1080, height: 1920 },
    sources: { cam: { path: "/m/cam.mov", fps: 25 }, vo: { path: "/m/vo.wav", fps: 25 } },
    tracks: { V1: { items: v1.map((s) => ({ ...s })) }, A1: { items: v1.map((s) => ({ ...s, src: "vo" })) } },
    ...more,
  } as NleTimeline);
const ALL: [number, number][] = [[0, 50], [50, 50], [100, 50]];

describe("the render bar's ranges", () => {
  it("keeps every shot as saved", () => {
    expect(stillCached(cut(), cut(), ALL)).toEqual(ALL);
  });

  it("drops a changed shot and keeps the rest", () => {
    const now = cut([shots[0]!, { ...shots[1]!, in: 110 }, shots[2]!]);
    expect(stillCached(now, cut(), ALL)).toEqual([[0, 50], [100, 50]]);
  });

  it("drops a shot whose voice changed", () => {
    const now = cut();
    now.tracks.A1!.items[2]!.gain_db = -3;
    expect(stillCached(now, cut(), ALL)).toEqual([[0, 50], [50, 50]]);
  });

  it("keeps shots a ripple moved, at their new place", () => {
    const now = cut([{ ...shots[1]!, rec: 0 }, { ...shots[2]!, rec: 50 }]);
    expect(stillCached(now, cut(), ALL)).toEqual([[0, 50], [50, 50]]);
  });

  it("drops both shots a new transition joins", () => {
    const now = cut([shots[0]!, shots[1]!, { ...shots[2]!, trans: { type: "dissolve", len: 10, at: "center" } }]);
    expect(stillCached(now, cut(), ALL)).toEqual([[0, 50]]);
  });

  it("joins touching ranges (a transition's segments) and keeps only what they cover", () => {
    expect(stillCached(cut(), cut(), [[0, 30], [30, 70]])).toEqual([[0, 50], [50, 50]]);
  });

  it("nothing after a change to the timeline's size, or with nothing cached", () => {
    expect(stillCached(cut(shots, { timeline: { fps: 25, width: 720, height: 1280 } }), cut(), ALL)).toEqual([]);
    expect(stillCached(cut(), cut(), [])).toEqual([]);
    expect(stillCached(cut(), cut(), undefined)).toEqual([]);
  });
});
