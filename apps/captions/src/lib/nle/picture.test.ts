import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { withKeys, type NleItem, type NleTimeline } from "./model";
import { chains, continues, drawScale, keyOf, pickSlot, picturesAt, picturesSoon, placement, plainVideo, soundPieces, sourceTime, steer } from "./picture";

type Case = { name: string; timeline: [number, number]; track: string; source: [number, number]; item: object; place: { matrix: number[]; crop: number[]; opacity: number } };
// the renderer's own answers for these clips (its geometry check writes them)
const fixture = JSON.parse(readFileSync(new URL("./geometry.fixture.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("nle picture", () => {
  it("puts every picture where the renderer does", () => {
    for (const c of fixture.cases) {
      const p = placement(c.item as NleItem, c.track, c.source[0], c.source[1], c.timeline[0], c.timeline[1]);
      p.m.forEach((v, i) => expect(v, `${c.name} matrix ${i}`).toBeCloseTo(c.place.matrix[i], 2));
      p.crop.forEach((v, i) => expect(v, `${c.name} crop ${i}`).toBeCloseTo(c.place.crop[i], 2));
      expect(p.alpha, c.name).toBeCloseTo(c.place.opacity, 3);
    }
    expect(fixture.cases.length).toBeGreaterThan(10);
  });

  it("plays the pictures that show, V1 at the bottom, and the sound that is heard", () => {
    const tl: NleTimeline = withKeys({
      timeline: { fps: 25 },
      sources: { a: { fps: 50 } },
      tracks: {
        V2: { items: [{ src: "a", rec: 10, len: 10, in: 0 }] },
        V1: { items: [{ src: "a", rec: 0, len: 50, in: 0 }] },
        V5: { name: "SOURCE", items: [{ src: "a", rec: 0, len: 5, in: 0 }] },
        V3: { hidden: true, items: [{ src: "a", rec: 0, len: 50, in: 0 }] },
        A1: { items: [{ src: "a", rec: 0, len: 50, in: 100, gain_db: -6 }] },
        A2: { mute: true, items: [{ src: "a", rec: 0, len: 50, in: 0 }] },
      },
    });
    expect(picturesAt(tl, 12).map((p) => p.track)).toEqual(["V1", "V2"]);
    expect(picturesAt(tl, 2).map((p) => p.track)).toEqual(["V1", "V5"]);
    expect(picturesAt(tl, 20).map((p) => p.track)).toEqual(["V1"]);
    const s = soundPieces(tl);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ at: 0, offset: 2, dur: 2 });
    expect(s[0].gain).toBeCloseTo(0.501, 3);
    // 50 fps source on a 25 fps timeline: a timeline second is 50 source frames
    expect(sourceTime(tl, tl.tracks.V2.items[0], 1)).toBeCloseTo(0.6);
  });
});

describe("the viewer's draw size", () => {
  it("draws a 2160 px frame at its size on screen in device px, never above the timeline's", () => {
    expect(drawScale(270, 2, 2160)).toBe(0.25);
    expect(drawScale(2160, 2, 2160)).toBe(1);
    expect(drawScale(540, 1, 1080)).toBe(0.5);
    expect(drawScale(0, 2, 2160)).toBe(1); // not laid out yet
  });
});

describe("a playing video kept to the clock", () => {
  it("leaves it within 2 frames, bends its speed further off, moves it only far off", () => {
    expect(steer(0.06, 1, 25)).toEqual({ rate: 1, seek: false });
    expect(steer(-0.3, 1, 25)).toEqual({ rate: 1.25, seek: false }); // a slow start catches up
    expect(steer(0.1, 2, 25).rate).toBeCloseTo(1.8);
    expect(steer(0.4, 1, 25)).toEqual({ rate: 0.75, seek: false });
    expect(steer(-0.7, 1, 25).seek).toBe(true);
  });
});

describe("a clip that plays on from the one before it in the same file", () => {
  // a Tiny Acrobatics talk cut into short clips: 0–25 then 25–50 of one file (nothing left out), a jump to 80, another file
  const tl = withKeys({
    timeline: { fps: 25, width: 2160, height: 3840 },
    sources: { a: { fps: 25 }, b: { fps: 50 } },
    tracks: {
      V1: { items: [
        { src: "a", rec: 0, len: 25, in: 0 },
        { src: "a", rec: 25, len: 25, in: 26 },
        { src: "a", rec: 50, len: 25, in: 80 },
        { src: "b", rec: 75, len: 25, in: 0 },
        { src: "b", rec: 100, len: 25, in: 50 },
        { src: "b", rec: 130, len: 25, in: 100 },
      ] },
    },
  } as unknown as NleTimeline);
  const it_ = tl.tracks.V1.items;

  it("keeps one element across the cut only when it continues the file from where the clip ends, at its speed", () => {
    // in 26 where the first ends at 25: within a frame
    expect(continues(tl, it_[0], it_[1])).toBe(true);
    // a jump cut leaves 30 frames out
    expect(continues(tl, it_[1], it_[2])).toBe(false);
    // another file
    expect(continues(tl, it_[2], it_[3])).toBe(false);
    // a 50 fps source: 25 timeline frames are 50 of its own
    expect(continues(tl, it_[3], it_[4])).toBe(true);
    // a gap on the timeline between them
    expect(continues(tl, it_[4], it_[5])).toBe(false);
    expect(continues(tl, it_[0], { ...it_[1], speed: 2 })).toBe(false);
    expect(continues(tl, it_[0], { ...it_[1], freeze: 1 } as NleItem)).toBe(false);
    const c = chains(tl);
    expect(c.get(keyOf(it_[1]))).toBe(keyOf(it_[0]));
    expect(c.get(keyOf(it_[2]))).toBe(keyOf(it_[2]));
    expect(c.get(keyOf(it_[4]))).toBe(keyOf(it_[3]));
  });

  it("opens only the next clip on a track, and none for one that plays on in the same element", () => {
    const c = chains(tl);
    // at frame 10 the next clip continues this one: the one after it (the jump to 80) is opened
    expect(picturesSoon(tl, 10, 50, c).map((p) => p.item.rec)).toEqual([50]);
    expect(picturesSoon(tl, 10, 10, c)).toEqual([]);
    expect(picturesSoon(tl, 60, 50, c).map((p) => p.item.rec)).toEqual([75]);
  });

  it("gives a run of clips the element it has, else a new one under two a file, else the one unused longest", () => {
    expect(pickSlot([{ owner: "x", used: 5, busy: true }], "x")).toBe(0);
    expect(pickSlot([{ owner: "x", used: 5, busy: true }], "y")).toBe(-1);
    expect(pickSlot([{ owner: "x", used: 5, busy: true }, { owner: "z", used: 1, busy: false }], "y")).toBe(1);
    expect(pickSlot([{ owner: "x", used: 5, busy: true }, { owner: "z", used: 1, busy: true }], "y")).toBeNull();
  });
});

describe("one plain picture shows as its <video>", () => {
  const on = (item: object, track = "V1") => [{ track, item: { src: "a", rec: 0, len: 25, in: 0, ...item } as NleItem }];
  it("only when exactly one picture shows with nothing changing how it is drawn", () => {
    expect(plainVideo(on({}))).toBe("cover");
    expect(plainVideo(on({}, "V3"))).toBe("contain");
    expect(plainVideo(on({ zoom: 1, crop: [0, 0, 0, 0], look: [] }))).toBe("cover");
    for (const more of [{ zoom: 1.2 }, { pan: 10 }, { crop: [0.1, 0, 0, 0] }, { opacity: 0.5 }, { fade_in: 5 }, { frame: "blur" }, { split: [{ src: "b", in: 0 }] }, { look: [["blur", 0, 5, 1]] }, { fit_x: 0.2 }, { rev: true }])
      expect(plainVideo(on(more))).toBeNull();
    expect(plainVideo([...on({}), ...on({}, "V2")])).toBeNull();
    expect(plainVideo([])).toBeNull();
  });
});
