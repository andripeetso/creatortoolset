import { describe, expect, it } from "vitest";
import { boxPick, addTrackAt, canDeleteTrack, deleteEmptyTracks, deleteTrack, dropPlan, keepLooks, lookOn, move, moveTarget, moveTrack, setMark, trackOrder, withKeys, type NleTimeline } from "./model";
import { placement } from "./picture";

// A Tiny Acrobatics reel, 1080×1920: the talk on V1 with its voice on A1 (linked), a wide B-roll shot on V3 (a track
// whose pictures fit inside the frame), a title on V2 that is locked, a song on A2, and an empty A3.
const reel = (): NleTimeline =>
  withKeys({
    timeline: { fps: 25, width: 1080, height: 1920 },
    sources: { cam: { path: "/m/cam.mp4", w: 1080, h: 1920 }, wide: { path: "/m/wide.mp4", w: 1920, h: 1080 }, song: { path: "/m/song.wav" } },
    tracks: {
      V1: { name: "TALENT", items: [{ src: "cam", rec: 0, len: 100, in: 0, link: 1 }] },
      V2: { name: "V2", locked: true, items: [{ src: "cam", rec: 0, len: 10, in: 0 }] },
      V3: { name: "V3", items: [{ src: "wide", rec: 50, len: 50, in: 0, zoom: 1.5 }] },
      A1: { items: [{ src: "cam", rec: 0, len: 100, in: 0, link: 1 }] },
      A2: { items: [{ src: "song", rec: 0, len: 150, in: 0 }] },
      A3: { items: [] },
    },
  } as unknown as NleTimeline);

const keyOn = (tl: NleTimeline, track: string, n = 0) => tl.tracks[track].items[n]._k!;
/** the picture's width on screen, frame px */
const shownW = (tl: NleTimeline, track: string) => {
  const it = tl.tracks[track].items[0];
  const s = tl.sources[it.src];
  return placement(it, track, s.w!, s.h!, 1080, 1920).m[0] * s.w!;
};

describe("a clip keeps its look on another track", () => {
  it("a wide shot moved from a fit track (V3) to a cover track (V1) gets the zoom that keeps its size", () => {
    const tl = reel();
    const before = shownW(tl, "V3");
    const it = lookOn(tl, tl.tracks.V3.items[0], "V3", "V1");
    const after: NleTimeline = { ...tl, tracks: { ...tl.tracks, V1: { items: [it] } } };
    // the same size, to the zoom's three decimals
    expect(Math.abs(shownW(after, "V1") / before - 1)).toBeLessThan(0.002);
    expect(it.zoom).toBeCloseTo(1.5 * (1080 / 1920) / (1920 / 1080), 3);
  });

  it("is left as it is between two tracks of one rule, or when the source's size isn't known", () => {
    const tl = reel();
    const it = tl.tracks.V1.items[0];
    expect(lookOn(tl, it, "V1", "V2")).toBe(it);
    const song = { ...tl.tracks.V3.items[0], src: "song" };
    expect(lookOn(tl, song, "V3", "V1")).toBe(song);
  });

  it("keepLooks fixes a move onto another track", () => {
    const tl = reel();
    const moved = keepLooks(tl, move(tl, [keyOn(tl, "V3")], 0, { from: "V3", to: "V1" }));
    expect(moved.tracks.V1.items.find((i) => i.src === "wide")!.zoom).toBeCloseTo(0.475, 3);
  });
});

describe("the track menu: a track keeps its number (the AI Editor reads tracks by number)", () => {
  it("adds a track only at a free number, the others untouched", () => {
    expect(addTrackAt(reel(), "V", 3)).toBeNull(); // V3 is taken
    expect(addTrackAt(reel(), "V", 0)).toBeNull();
    const got = addTrackAt(reel(), "V", 4)!;
    expect(got.id).toBe("V4");
    expect(got.tl.tracks.V4.items).toEqual([]);
    expect(got.tl.tracks.V3.items[0].zoom).toBe(1.5);
  });

  it("moves a track by trading numbers with its neighbour, never past the end or a locked one", () => {
    const tl = reel();
    expect(moveTarget(tl, "V1", true)).toBeNull(); // V2 above it is locked
    expect(moveTarget(tl, "V3", true)).toBeNull(); // the top
    expect(moveTarget(tl, "A1", false)).toBe("A2");
    const a = moveTrack(tl, "A1", false);
    expect(a.tracks.A2.items[0].link).toBe(1);
    expect(a.tracks.A1.items[0].src).toBe("song");
    expect(moveTrack(tl, "A1", true)).toBe(tl);
    expect(trackOrder(a)).toEqual(trackOrder(tl));
  });

  it("deletes a track with its clips and leaves the other numbers; never a locked one, V1 or A1", () => {
    const tl = reel();
    const out = deleteTrack(tl, "A2");
    expect(Object.keys(out.tracks).filter((t) => t[0] === "A").sort()).toEqual(["A1", "A3"]);
    expect(canDeleteTrack(tl, "V2")).toBe(false);
    expect(canDeleteTrack(tl, "V1")).toBe(false);
    expect(canDeleteTrack(tl, "A1")).toBe(false);
  });

  it("deletes the empty tracks, numbers kept: a gap stays a gap", () => {
    const gaps = withKeys({ timeline: { fps: 25 }, sources: {}, tracks: {
      V1: { items: [] }, V2: { items: [] }, V3: { items: [{ src: "x", rec: 0, len: 5, in: 0 }] }, A1: { items: [] }, A2: { items: [] }, A4: { items: [{ src: "x", rec: 0, len: 5, in: 0 }] },
    } } as unknown as NleTimeline);
    expect(Object.keys(deleteEmptyTracks(gaps).tracks).sort()).toEqual(["A1", "A4", "V1", "V3"]);
    expect(Object.keys(deleteEmptyTracks(reel()).tracks).sort()).toEqual(["A1", "A2", "V1", "V2", "V3"]);
  });
});

describe("marks", () => {
  it("In and Out on one frame mark that one frame", () => {
    expect(setMark(setMark([null, null], "in", 10), "out", 10)).toEqual([10, 10]);
    expect(setMark(setMark([null, null], "out", 10), "in", 10)).toEqual([10, 10]);
    expect(setMark([10, 20], "in", 25)).toEqual([25, null]);
  });
});

describe("box select", () => {
  it("picks every clip the box touches on the tracks it spans, not on locked ones", () => {
    const tl = reel();
    expect(boxPick(tl, ["V1", "V2", "V3"], 60, 40)).toEqual([keyOn(tl, "V1"), keyOn(tl, "V3")]);
    expect(boxPick(tl, ["V3", "A1"], 0, 49)).toEqual([keyOn(tl, "A1")]);
    // a box ending right where a clip starts doesn't take it; a zero-wide one at a cut takes the clip after it
    expect(boxPick(tl, ["V3"], 100, 120)).toEqual([]);
    expect(boxPick(tl, ["V3"], 50, 50)).toEqual([keyOn(tl, "V3")]);
  });
});

describe("where a drop lands", () => {
  it("a picture with sound: its track, and the sound on the first free sound track", () => {
    const tl = reel();
    expect(dropPlan(tl, "V1", 200, 50, true)).toEqual([{ track: "V1", rec: 200, len: 50 }, { track: "A1", rec: 200, len: 50 }]);
    // over the talk, on V3: A1 and A2 are taken there, A3 is free
    expect(dropPlan(tl, "V3", 10, 50, true)[1].track).toBe("A3");
    expect(dropPlan(tl, "V3", 10, 50, false)).toHaveLength(1);
    expect(dropPlan(tl, "A2", 10, 50, true)).toEqual([{ track: "A2", rec: 10, len: 50 }]);
  });
});
