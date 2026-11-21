import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { KeyProp } from "@contracts/editor";
import { KEY_STATIC } from "./keyframes";
import { withKeys, type NleItem, type NleTimeline } from "./model";
import { chains, continues, drawScale, envPoints, keyed, keyOf, pickSlot, picturesAt, picturesSoon, placement, plainVideo, soundPieces, sourceTime, steer } from "./picture";

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
    expect(continues(tl, it_[0], { ...it_[1], freeze: true })).toBe(false);
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

// the player's per-frame values against the golden vectors the studio engine renders from (contracts/edj-golden.json)
type GoldenKey = { name: string; fps: number; sfps: number; prop: string; item: NleItem; frames: number[]; values: number[] };
type GoldenTrans = { name: string; type: string; len: number; at: string; cut: number; start: number; frames: number[] } & Record<string, unknown>;
const golden = JSON.parse(readFileSync(new URL("../../../contracts/edj-golden.json", import.meta.url), "utf8")) as { keys: GoldenKey[]; trans: GoldenTrans[] };
const gainAt = (p: { env?: [number, number][]; gain: number }, secs: number) => (p.env ? envPoints(p.env, 0, secs, 1)[0][1] : p.gain);

describe("the player's frame against the golden vectors", () => {
  it("draws keyed zoom, pan, tilt, rotation and opacity and plays keyed gain at the golden's values", () => {
    for (const c of golden.keys) {
      const sound = c.prop === "gain_db";
      const tl = withKeys({ timeline: { fps: c.fps }, sources: { s: { fps: c.sfps } }, tracks: { [sound ? "A1" : "V2"]: { items: [c.item] } } });
      const it = Object.values(tl.tracks)[0].items[0];
      c.frames.forEach((f, i) => {
        if (sound) {
          const p = soundPieces(tl)[0];
          expect(20 * Math.log10(gainAt(p, (f - c.item.rec) / c.fps)), `${c.name} @${f}`).toBeCloseTo(c.values[i], 5);
        } else expect((keyed(tl, it, f)[c.prop] ?? KEY_STATIC[c.prop as KeyProp]) as number, `${c.name} @${f}`).toBeCloseTo(c.values[i], 6);
      });
    }
  });

  it("mixes a transition's two clips at the golden's shares on V1 and V2, and crossfades their sound", () => {
    for (const c of golden.trans) {
      const trans = { type: c.type, len: c.len, at: c.at } as NleItem["trans"];
      const pair = () => ({ items: [{ src: "s", rec: c.cut - 40, len: 40, in: 100 }, { src: "s", rec: c.cut, len: 40, in: 300, trans }] });
      const sound = c.type === "crossfade";
      const tl = withKeys({ timeline: { fps: 25 }, sources: { s: { fps: 25 } }, tracks: sound ? { A1: pair() } : { V1: pair(), V2: pair() } });
      c.frames.forEach((f, i) => {
        const w = (k: string) => (c[k] as number[])[i];
        if (sound) {
          const [a, b] = soundPieces(tl);
          expect(gainAt(a, (f - (c.cut - 40)) / 25), `${c.name} a @${f}`).toBeCloseTo(w("a"), 5);
          expect(gainAt(b, (f - c.start) / 25), `${c.name} b @${f}`).toBeCloseTo(w("b"), 5);
          return;
        }
        for (const track of ["V1", "V2"]) {
          const on = picturesAt(tl, f).filter((p) => p.track === track);
          expect(on.map((p) => p.item.rec), `${c.name} ${track} @${f}`).toEqual([c.cut - 40, c.cut]);
          const [a, b] = on;
          if (c.type === "dissolve") {
            expect(a.seen).toBe(1);
            expect(b.seen, `${c.name} @${f}`).toBeCloseTo(w("alpha"), 5);
          } else {
            expect(a.seen, `${c.name} a @${f}`).toBeCloseTo(w("a"), 5);
            expect(b.seen, `${c.name} b @${f}`).toBeCloseTo(w("b"), 5);
            expect(a.under).toBe(c.type === "dip_white" ? "white" : "black");
          }
        }
      });
      if (sound) continue;
      // before the transition only the earlier clip, after it only the later, each at full
      expect(picturesAt(tl, c.start - 1).filter((p) => p.track === "V1").map((p) => [p.item.rec, p.seen])).toEqual([[c.cut - 40, 1]]);
      expect(picturesAt(tl, c.start + c.len).filter((p) => p.track === "V1").map((p) => [p.item.rec, p.seen])).toEqual([[c.cut, 1]]);
    }
  });

  it("plays both clips of a transition from their handles, each its own element, never as the plain <video>", () => {
    const tl = withKeys({
      timeline: { fps: 25 },
      sources: { s: { fps: 25 } },
      tracks: { V1: { items: [{ src: "s", rec: 0, len: 50, in: 0 }, { src: "s", rec: 50, len: 50, in: 50, trans: { type: "dissolve", len: 10, at: "center" } }] } },
    });
    const [a, b] = tl.tracks.V1.items;
    // the same file straight on, but a transition between: two elements
    expect(continues(tl, a, b)).toBe(false);
    expect(plainVideo(picturesAt(tl, 47))).toBeNull();
    expect(plainVideo(picturesAt(tl, 60))).toBe("cover");
    // the later clip opens before its transition starts, at frame 45
    expect(picturesSoon(tl, 40, 5, chains(tl)).map((p) => p.item.rec)).toEqual([50]);
    expect(picturesSoon(tl, 40, 4, chains(tl))).toEqual([]);
    // a keyed clip is drawn on the canvas
    expect(plainVideo([{ track: "V1", item: { ...a, keys: { zoom: [[0, 1, "linear"], [10, 2, "linear"]] } } }])).toBeNull();
  });

  it("adds norm_db to a clip's gain, keyed or not, and leaves the fades to the sound engine without keys", () => {
    const tl = withKeys({
      timeline: { fps: 25 },
      sources: { s: { fps: 25 } },
      tracks: {
        A1: { items: [{ src: "s", rec: 0, len: 50, in: 0, gain_db: -6, norm_db: -3, fade_in: 5 }] },
        A2: { items: [{ src: "s", rec: 0, len: 50, in: 0, norm_db: 4, keys: { gain_db: [[0, -10, "linear"], [10, 0, "linear"]] } }] },
      },
    });
    const [p1, p2] = soundPieces(tl);
    expect(20 * Math.log10(p1.gain)).toBeCloseTo(-9, 6);
    expect(p1).toMatchObject({ fadeIn: 0.2 });
    expect(p1.env).toBeUndefined();
    expect(20 * Math.log10(gainAt(p2, 0))).toBeCloseTo(-6, 6);
    expect(20 * Math.log10(gainAt(p2, 5 / 25))).toBeCloseTo(-1, 6);
    expect(20 * Math.log10(gainAt(p2, 1))).toBeCloseTo(4, 6);
    // a run of the same value is two points, not one a frame
    expect(p2.env!.length).toBeLessThan(15);
  });
});
