import { describe, expect, it } from "vitest";
import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import { placeCards } from "./cards/place";
import { emptyTracks, noPicture } from "./timeline";
import { BROLL_NOTE, COVER_SHOT_FRAMES, coverWindows, freeStart, placeBroll, placeCover, rulesAt, windowsOf } from "./broll";

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

/** A voice with no picture, 30 fps: one take on V1 and A1, a marker where each line starts (its note: what is said). */
function spoken(lines: [number, string][], end: number): Timeline {
  const tracks = emptyTracks();
  tracks.V1.items = [{ src: "voice", in: 0, len: end, rec: 0, link: "c1" }];
  tracks.A1.items = [{ src: "voice", in: 0, len: end, rec: 0, link: "c1" }];
  return {
    name: "no picture",
    fps: 30,
    width: 1080,
    height: 1920,
    sources: { voice: { versionId: "voice", name: "voice", fps: 30, tc: 0, dur: 3000, w: 0, h: 0 } },
    tracks,
    markers: lines.map(([rec, note], n) => ({ rec, name: `L${n + 1}`, color: "BLUE", note })),
  };
}

/** The picture's shots end to end from frame 0: where it ends, or -1 at a gap or an overlap. */
const coveredTo = (items: { rec: number; len: number }[]) => [...items].sort((a, b) => a.rec - b.rec).reduce((at, i) => (i.rec === at ? at + i.len : -1), 0);

describe("a cut whose takes have no picture: the B-roll is the whole picture", () => {
  const lines: [number, string][] = [
    [0, "Roll the mat out"],
    [100, "Yes"],
    [120, "Then the ramp goes on the floor"],
    [400, "Try it today"],
  ];

  it("is told by its takes: every one without a picture", () => {
    expect(noPicture(spoken(lines, 600))).toBe(true);
    expect(noPicture(fixture(shots, [0, 300]))).toBe(false);
    expect(noPicture({ ...spoken(lines, 600), tracks: emptyTracks() })).toBe(false);
  });

  it("the shots run from the first frame to the last, cut where a line starts, none longer than the rule or shorter than a cutaway", () => {
    const wins = coverWindows(spoken(lines, 600));
    const r = rulesAt(30);
    expect(coveredTo(wins)).toBe(600);
    for (const w of wins) {
      expect(w.len).toBeLessThanOrEqual((COVER_SHOT_FRAMES * 30) / 25);
      expect(w.len).toBeGreaterThanOrEqual(r.min);
    }
    const starts = wins.map((w) => w.rec);
    expect(starts).toContain(120);
    expect(starts).toContain(400);
    // "Yes" is 20 frames: no shot of its own, the line before it keeps the picture and gains its words
    expect(starts).not.toContain(100);
    expect(wins[0]!.text).toBe("Roll the mat out Yes");
  });

  it("a short first line takes the next line in, and a cut with no markers is still covered", () => {
    const wins = coverWindows(spoken([[0, "Hi"], [10, "Roll the mat out"]], 80));
    expect(wins).toEqual([{ rec: 0, len: 80, text: "Hi Roll the mat out" }]);
    expect(coveredTo(coverWindows(spoken([], 200)))).toBe(200);
  });

  it("covers every frame and leaves the voice as it was", () => {
    const tl = spoken(lines, 600);
    const { timeline, notes } = placeCover(tl, [src("broll_a", 2000), src("broll_b", 2000)]);
    expect(coveredTo(timeline.tracks.V2.items)).toBe(600);
    expect(timeline.tracks.V1).toEqual(tl.tracks.V1);
    expect(timeline.tracks.A1).toEqual(tl.tracks.A1);
    expect(notes).toEqual([]);
    // never the same moment of a clip twice
    for (const id of ["broll_a", "broll_b"]) {
      const used = timeline.tracks.V2.items.filter((i) => i.src === id).sort((a, b) => a.in - b.in);
      used.forEach((i, k) => k && expect(i.in).toBeGreaterThanOrEqual(used[k - 1]!.in + used[k - 1]!.len));
    }
  });

  it("a shot takes the clip whose words fit it, and a clip shown less often goes before one shown more", () => {
    const tl = spoken(lines, 600);
    const rank = (text: string) => (/mat/.test(text) ? ["mat_clip"] : /ramp/.test(text) ? ["ramp_clip", "mat_clip"] : []);
    const { timeline } = placeCover(tl, [src("other", 2000), src("mat_clip", 2000), src("ramp_clip", 2000)], rank);
    const at = (rec: number) => timeline.tracks.V2.items.find((i) => i.rec <= rec && rec < i.rec + i.len)!.src;
    expect(at(0)).toBe("mat_clip");
    expect(at(120)).toBe("ramp_clip");
    // the ramp line is cut into several shots: its second fit, already shown once, comes after the clip that was not
    expect(new Set(timeline.tracks.V2.items.filter((i) => i.rec >= 120 && i.rec < 400).map((i) => i.src))).toContain("mat_clip");
    // no fit for the last line: the clip shown least
    expect(at(400)).toBe("other");
  });

  it("with less footage than the video is long, a moment is shown again and said so: still no black frame", () => {
    const tl = spoken(lines, 600);
    const { timeline, notes } = placeCover(tl, [src("short", 50), src("shorter", 20)]);
    expect(coveredTo(timeline.tracks.V2.items)).toBe(600);
    for (const i of timeline.tracks.V2.items) expect(i.in + i.len).toBeLessThanOrEqual(timeline.sources[i.src]!.dur);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^B-roll: the folder has less footage than this video is long: \d+ shots show a moment again$/);
  });

  it("a card takes its place in the picture and the B-roll around it stays: still no black frame", () => {
    const tl = spoken(lines, 600);
    // a voice piece per line, as a draft has them
    tl.tracks.V1.items = [0, 100, 120, 400].map((rec, k, all) => ({ src: "voice", in: rec, len: (all[k + 1] ?? 600) - rec, rec, link: `c${k + 1}` }));
    const covered = placeCover(tl, [src("broll_a", 2000), src("broll_b", 2000)]).timeline;
    const card = { key: "card-1", text: "Ramp down", line: "L3", source: { ...src("card-1", 60), file: "cards/v1/c1.mp4" } };
    const { timeline, notes } = placeCards(covered, [card]);
    expect(notes).toEqual([]);
    expect(timeline.tracks.V2.items.find((i) => i.src === "card-1")).toMatchObject({ rec: 340, len: 60 });
    expect(coveredTo(timeline.tracks.V2.items)).toBe(600);
    // the shot the card cut into carries on after it from the frames it would have shown then
    const before = covered.tracks.V2.items.find((i) => i.rec < 340 && i.rec + i.len > 340)!;
    expect(timeline.tracks.V2.items.find((i) => i.src === before.src && i.rec === before.rec)).toMatchObject({ len: 340 - before.rec, in: before.in });
  });

  it("a folder with no picture in it covers nothing and says why", () => {
    const { timeline, notes } = placeCover(spoken(lines, 600), [{ ...src("sound", 500), w: 0, h: 0 }]);
    expect(timeline.tracks.V2.items).toEqual([]);
    expect(notes).toEqual([`${BROLL_NOTE}no clip with picture in the collection`]);
  });
});
