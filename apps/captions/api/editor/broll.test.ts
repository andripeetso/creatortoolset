import { describe, expect, it } from "vitest";
import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import { emptyTracks } from "./timeline";
import { BROLL_NOTE, freeStart, placeBroll, rulesAt, windowsOf } from "./broll";

const src = (versionId: string, dur: number): TimelineSource => ({ versionId, name: versionId, fps: 30, tc: 0, dur, w: 1080, h: 1920 });

/** A 30 fps fixture: his shots at 0, 90, 180 and a last shot (the CTA line starts at 300). */
function fixture(speaker: Item[], markers: number[]): Timeline {
  const tracks = emptyTracks();
  tracks.V1.items = speaker.map((i) => ({ ...i, src: "talk" }));
  return {
    name: "fixture",
    fps: 30,
    width: 1080,
    height: 1920,
    sources: { talk: src("talk", 1000) },
    tracks,
    markers: markers.map((rec, n) => ({ rec, name: `L${n + 1}`, color: "BLUE", note: "" })),
  };
}

const shots: Item[] = [
  { src: "talk", in: 0, len: 90, rec: 0 },
  { src: "talk", in: 90, len: 90, rec: 90 },
  { src: "talk", in: 180, len: 120, rec: 180 },
  { src: "talk", in: 300, len: 60, rec: 300 },
];

describe("B-roll placement (code rules, no model)", () => {
  it("the rules scale from 25 fps to the timeline's rate", () => {
    expect(rulesAt(25)).toEqual({ hook: 37, min: 30, max: 60, gap: 20 });
    expect(rulesAt(30)).toEqual({ hook: 44, min: 36, max: 72, gap: 24 });
  });

  it("the shortest cutaway placed is QA's minimum (1.2 s) at every rate, and one frame less is under it", () => {
    for (const fps of [24, 25, 26, 30, 60]) {
      const min = rulesAt(fps).min;
      expect(min / fps).toBeGreaterThanOrEqual(1.2);
      expect((min - 1) / fps).toBeLessThan(1.2);
    }
  });

  it("lays a cutaway over the speaker track, V1 untouched", () => {
    const tl = fixture(shots, [0, 300]);
    const pool = [src("broll_a", 1000)];
    const { timeline, notes } = placeBroll(tl, pool);
    expect(timeline.tracks.V2.items.length).toBeGreaterThan(0);
    expect(timeline.tracks.V1).toEqual(tl.tracks.V1);
    expect(notes).toEqual([]);
  });

  it("no cut in the hook or the CTA", () => {
    const tl = fixture(shots, [0, 300]);
    const r = rulesAt(30);
    for (const i of placeBroll(tl, [src("broll_a", 1000)]).timeline.tracks.V2.items) {
      expect(i.rec).toBeGreaterThanOrEqual(r.hook);
      expect(i.rec + i.len).toBeLessThanOrEqual(300);
    }
  });

  it("every cutaway is min..max frames long, and his face is at least the face gap between two", () => {
    const tl = fixture(shots, [0, 300]);
    const r = rulesAt(30);
    const items = placeBroll(tl, [src("broll_a", 1000)]).timeline.tracks.V2.items;
    for (const i of items) {
      expect(i.len).toBeGreaterThanOrEqual(r.min);
      expect(i.len).toBeLessThanOrEqual(r.max);
    }
    for (let k = 1; k < items.length; k++) expect(items[k]!.rec - (items[k - 1]!.rec + items[k - 1]!.len)).toBeGreaterThanOrEqual(r.gap);
  });

  it("ends each cutaway on one of his cuts", () => {
    const tl = fixture(shots, [0, 300]);
    const cuts = new Set([0, 90, 180, 300, 360]);
    for (const i of placeBroll(tl, [src("broll_a", 1000)]).timeline.tracks.V2.items) expect(cuts.has(i.rec + i.len)).toBe(true);
  });

  it("never uses a moment of a clip twice, and a clip too short for the cut is skipped", () => {
    const tl = fixture(shots, [0, 300]);
    const pool = [src("short", 40), src("broll_a", 1000)];
    const items = placeBroll(tl, pool).timeline.tracks.V2.items;
    expect(items.every((i) => i.src === "broll_a")).toBe(true);
    const ranges = items.map((i) => [i.in, i.in + Math.round((i.len * 30) / 30)] as [number, number]).sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < ranges.length; k++) expect(ranges[k]![0]).toBeGreaterThanOrEqual(ranges[k - 1]![1]);
  });

  it("with no usable clip, the cut gets no cutaway and a note says why", () => {
    const tl = fixture(shots, [0, 300]);
    const { timeline, notes } = placeBroll(tl, [src("short", 10)]);
    expect(timeline.tracks.V2.items).toEqual([]);
    expect(notes[0]).toContain(BROLL_NOTE);
  });

  it("a shot longer than the maximum keeps its cut and starts later", () => {
    const tl = fixture([{ src: "talk", in: 0, len: 200, rec: 0 }], [0, 150]);
    expect(windowsOf(tl)).toEqual([{ rec: 150 - rulesAt(30).max, len: rulesAt(30).max }]);
  });

  it("freeStart finds the first clear stretch of a clip", () => {
    expect(freeStart([[0, 53]], 60, 1000)).toBe(53);
    expect(freeStart([[0, 53], [53, 100]], 60, 150)).toBeNull();
    expect(freeStart([], 60, 59)).toBeNull();
  });
});
