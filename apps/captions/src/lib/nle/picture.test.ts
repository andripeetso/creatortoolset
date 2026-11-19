import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { withKeys, type NleItem, type NleTimeline } from "./model";
import { drawScale, picturesAt, placement, soundPieces, sourceTime, steer } from "./picture";

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
