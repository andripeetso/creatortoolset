import { describe, expect, it } from "vitest";
import { delKey, keysIn, setKey, shotToKeys, valueAt, valueOn } from "./keyframes";
import { setTrack, withKeys, type NleItem, type NleTimeline } from "./model";
import { framingAt } from "./shot";

// A Tiny Acrobatics reel: a talking shot on V1 (25 fps like the timeline) and a 50 fps B-roll clip on V2.
const reel = (): NleTimeline =>
  withKeys({
    timeline: { fps: 25, width: 1080, height: 1920 },
    sources: { cam: { fps: 25, dur: 1000 }, b: { fps: 50, dur: 400 } },
    tracks: { V1: { items: [{ src: "cam", rec: 0, len: 75, in: 100, zoom: 1.2 }] }, V2: { items: [{ src: "b", rec: 90, len: 40, in: 0 }] } },
  });
const k = (tl: NleTimeline, track: string) => tl.tracks[track].items[0]._k!;
const item = (tl: NleTimeline, track: string) => tl.tracks[track].items[0];

describe("keyframes", () => {
  it("sets keys in source frames at the playhead: a new one linear, one on the same frame changed in place", () => {
    let tl = reel();
    const v1 = k(tl, "V1");
    tl = setKey(tl, v1, "zoom", 10, 1.5);
    expect(item(tl, "V1").keys).toEqual({ zoom: [[110, 1.5, "linear"]] });
    // one key: held everywhere; the clip's own zoom no longer counts
    expect(valueOn(tl, v1, "zoom", 60)).toBe(1.5);
    tl = setKey(tl, v1, "zoom", 50, 2, "ease");
    tl = setKey(tl, v1, "zoom", 0); // no value: the value there now
    expect(item(tl, "V1").keys!.zoom).toEqual([[100, 1.5, "linear"], [110, 1.5, "linear"], [150, 2, "ease"]]);
    tl = setKey(tl, v1, "zoom", 10, undefined, "hold");
    expect(item(tl, "V1").keys!.zoom![1]).toEqual([110, 1.5, "hold"]);
    expect(valueOn(tl, v1, "zoom", 49)).toBe(1.5);
    // a 50 fps source on a 25 fps timeline: 2 source frames a timeline frame
    const v2 = k(tl, "V2");
    tl = setKey(tl, v2, "opacity", 100, 0.5);
    expect(item(tl, "V2").keys).toEqual({ opacity: [[20, 0.5, "linear"]] });
  });

  it("deletes keys; the last one leaves its value as the clip's own", () => {
    let tl = reel();
    const v1 = k(tl, "V1");
    tl = setKey(setKey(tl, v1, "rot", 0, 5), v1, "rot", 20, -5);
    tl = delKey(tl, v1, "rot", 0);
    expect(item(tl, "V1").keys).toEqual({ rot: [[120, -5, "linear"]] });
    expect(delKey(tl, v1, "rot", 3)).toBe(tl);
    tl = delKey(tl, v1, "rot", 20);
    expect(item(tl, "V1").keys).toBeUndefined();
    expect(item(tl, "V1").rot).toBe(-5);
  });

  it("lists the keys that fall on the clip at their timeline frames", () => {
    let tl = reel();
    const v2 = k(tl, "V2");
    tl = setKey(tl, v2, "pan", 100, 10);
    tl = setKey(tl, v2, "pan", 129, 20);
    // a key past the clip's end (its source runs on there)
    tl.tracks.V2.items[0].keys!.pan!.push([200, 30, "linear"]);
    expect(keysIn(tl, v2, "pan")).toEqual([{ f: 100, key: [20, 10, "linear"] }, { f: 129, key: [78, 20, "linear"] }]);
    expect(keysIn(tl, v2, "zoom")).toEqual([]);
  });

  it("leaves a locked track alone", () => {
    const tl = setTrack(reel(), "V1", { locked: true });
    expect(setKey(tl, k(tl, "V1"), "zoom", 10, 2)).toBe(tl);
  });

  it("turns a shot-list framing into keys on the same curve (eased and linear, 50 fps on 25)", () => {
    const shot: NleItem = { src: "b", rec: 30, len: 50, in: 100, zoom: 1.1, zoom_to: 1.6, pan: 0, pan_to: 40, tilt: 10, tilt_to: -20, move: [0.2, 0.9] };
    for (const it of [shot, { ...shot, ease: "linear" }]) {
      const keyed = { ...it, ...shotToKeys(it, 2) };
      expect(keyed.zoom_to).toBeUndefined();
      for (const f of [0, 7, 20, 33, 49]) {
        const want = framingAt(it, f);
        (["zoom", "pan", "tilt"] as const).forEach((p, n) => expect(valueAt(keyed, p, it.rec + f, 25, 50)).toBeCloseTo(want[n]!, 9));
      }
    }
    // the first framing edit converts it, the other props with it
    const tl = withKeys({ timeline: { fps: 25 }, sources: { b: { fps: 50 } }, tracks: { V1: { items: [shot] } } });
    const out = setKey(tl, k(tl, "V1"), "zoom", 40, 3);
    expect(item(out, "V1").zoom_to).toBeUndefined();
    expect(item(out, "V1").keys!.pan).toHaveLength(2);
    expect(item(out, "V1").keys!.zoom).toHaveLength(3);
    expect(shotToKeys({ src: "b", rec: 0, len: 5, in: 0, zoom: 2 }, 1)).toEqual({});
  });
});
