import { describe, expect, it } from "vitest";
import type { Item, Timeline } from "../../contracts/editor";
import { exportGaps, motion, retime } from "./carry";
import { emptyTracks } from "./timeline";

const tl = (items: Item[] = []): Timeline => {
  const t: Timeline = { name: "Tiny", fps: 25, width: 1080, height: 1920, sources: {}, tracks: emptyTracks(), markers: [] };
  t.tracks.V1.items = items;
  return t;
};
const shot = (o: Partial<Item> = {}): Item => ({ src: "a", in: 0, len: 50, rec: 0, ...o });

describe("what a timeline file carries of the preview", () => {
  it("a still shot is one key with its zoom and tilt", () => {
    expect(motion(tl(), shot({ zoom: 1.2, tilt: 30 }))).toEqual([{ f: 0, zoom: 1.2, x: 0, y: 30 }]);
  });

  it("a punch jumps in on its frame and eases back out over 0.3 s, on top of the shot's zoom", () => {
    const keys = motion(tl(), shot({ zoom: 1.1, fx: [{ type: "punch", at: 1, amount: 1.5 }] }));
    expect(keys).toEqual([
      { f: 0, zoom: 1.1, x: 0, y: 0 },
      { f: 24, zoom: 1.1, x: 0, y: 0 },
      { f: 25, zoom: 1.65, x: 0, y: 0 },
      { f: 33, zoom: 1.1, x: 0, y: 0 }, // 1.3 s, rounded to the frame
      { f: 50, zoom: 1.1, x: 0, y: 0 },
    ]);
  });

  it("a shake scales the whole shot up and moves every frame of its window; a whip slides in from the right", () => {
    const keys = motion(tl(), shot({ fx: [{ type: "shake", at: 0.4, dur: 0.2, amount: 0.5 }] }));
    expect(new Set(keys.map((k) => k.zoom))).toEqual(new Set([1.1])); // 1 + 2 × 0.05
    expect(keys.filter((k) => k.x !== 0).map((k) => k.f)).toEqual([10, 11, 12, 13, 14, 15]);
    const whip = motion(tl(), shot({ enter: "whip" }));
    expect(whip.map((k) => [k.f, k.x])).toEqual([[0, 270], [3, 0], [50, 0]]);
  });

  it("a freeze holds the source and the shot's end is cut by as much; reverse runs it from the end", () => {
    expect(retime(tl(), shot())).toBeNull();
    expect(retime(tl(), shot({ speed: 2 }))).toBeNull();
    expect(retime(tl(), shot({ fx: [{ type: "freeze", at: 0.5, dur: 0.4 }] }))).toEqual([
      { t: 0, v: 0 },
      { t: 0.5, v: 0.5 },
      { t: 0.9, v: 0.5 },
      { t: 2, v: 1.6 },
    ]);
    expect(retime(tl(), shot({ speed: 2, fx: [{ type: "reverse" }] }))).toEqual([{ t: 0, v: 4 }, { t: 2, v: 0 }]);
  });

  it("gaps: per editor, what its file leaves out with how many shots; nothing for a plain cut", () => {
    expect(exportGaps(tl([shot(), shot({ rec: 50, zoom: 1.2 })]))).toEqual({});
    const t = tl([
      shot({ fx: [{ type: "shake", at: 0 }, { type: "glitch", at: 0 }], frame: "blur" }),
      shot({ rec: 50, fx: [{ type: "shake", at: 0 }, { type: "freeze", at: 0 }], enter: "dissolve" }),
    ]);
    t.tracks.V2.items = [shot()];
    t.tracks.A2.items = [shot()];
    t.plan = { kind: "reel", texts: [{ at: 0, dur: 1, text: "Hi", place: "middle" }] };
    const g = exportGaps(t, true);
    expect(g.resolve).toEqual(["glitch on 1 shot", "blurred backgrounds on 1 shot", "freeze frames on 1 shot", "words on screen"]);
    expect(g["final-cut"]).toEqual(["glitch on 1 shot", "blurred backgrounds on 1 shot", "words on screen", "B-roll", "music", "colour grade"]);
    expect(g.premiere).toContain("dissolves on 1 shot");
    expect(g.premiere).toContain("freeze frames on 1 shot");
    expect(g.premiere).not.toContain("shake on 2 shots");
  });

  it("a reframed shot's moving window is carried by every file: no gap", () => {
    const t = tl([shot({ zoom: 3.16, path: [{ t: 0, x: 0 }, { t: 2, x: 1 }] })]);
    t.sources.a = { versionId: "a", name: "Talk", fps: 25, tc: 0, dur: 2500, w: 1920, h: 1080 };
    expect(exportGaps(t)).toEqual({});
  });
});
