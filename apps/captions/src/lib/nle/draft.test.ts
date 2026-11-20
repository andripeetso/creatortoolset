import { describe, expect, it } from "vitest";
import type { Timeline } from "@contracts/editor";
import { handCheck, NOT_RENDERED, unrendered } from "./check";
import { fromNle, toNle } from "./draft";
import { toSaved, trim, withKeys } from "./model";

/** A draft of a wide take on a tall timeline, with what a planned edit and the AI wrote on it. */
const draft = (): Timeline => ({
  name: "Tiny v1", fps: 30, width: 1080, height: 1920,
  sources: { ver_w: { versionId: "ver_w", name: "Wide", fps: 30, tc: 0, dur: 900, w: 1920, h: 1080 } },
  tracks: {
    V1: { name: "Speaker", items: [{ src: "ver_w", in: 0, len: 60, rec: 0, zoom: 2, tilt: 40, link: "a", fx: [{ kind: "shake" } as never] }] },
    V2: { name: "B-roll", items: [] },
    A1: { name: "Voice", items: [{ src: "ver_w", in: 0, len: 60, rec: 0, gainDb: -2, link: "a" }] },
    A2: { name: "Music", items: [] },
    A3: { name: "Sound effects", items: [] },
  },
  markers: [{ rec: 30, name: "Line 2", color: "BLUE", note: "" }],
  speakers: [{ rec: 0, len: 60, speaker: 1 }],
  plan: { kind: "talking head" },
});

describe("a draft in the editor and back", () => {
  it("round trips with every field either side doesn't know, the sound's gain and the markers", () => {
    const tl = draft();
    const nle = toNle(tl);
    expect(nle.timeline).toEqual({ name: "Tiny v1", fps: 30, width: 1080, height: 1920 });
    expect(nle.tracks.A1.items[0]).toMatchObject({ gain_db: -2 });
    expect(nle.markers).toEqual([{ frame: 30, name: "Line 2", color: "Blue", note: "" }]);
    expect(nle.speakers).toEqual(tl.speakers);
    const back = fromNle(toSaved(withKeys(nle)));
    expect(back).toEqual(tl);
  });

  it("zoom: fitted inside the frame there, covering it here, so a wide take's zoom 2 is about 0.63 here", () => {
    const nle = toNle(draft());
    // fitted: 1080 / 1920 wide; covering: 1920 / 1080 tall → the ratio (1080/1920)²
    expect(nle.tracks.V1.items[0]!.zoom).toBeCloseTo(2 * (1080 / 1920) ** 2, 5);
    nle.tracks.V1.items[0]!.zoom = (1080 / 1920) ** 2; // covering the frame there is fitted × 1 here
    expect(fromNle(nle).tracks.V1.items[0]!.zoom).toBeUndefined();
  });

  it("an edit on it is kept: a trim moves the frames, the AI's fields stay on the clip", () => {
    const nle = withKeys(toNle(draft()));
    const k = nle.tracks.V1.items[0]!._k!;
    const back = fromNle(toSaved(trim(nle, k, "tail", -10)));
    expect(back.tracks.V1.items[0]).toMatchObject({ len: 50, fx: [{ kind: "shake" }], tilt: 40 });
    expect(back.tracks.A1.items[0]).toMatchObject({ len: 50, gainDb: -2 });
  });
});

/** Renders that draw every field of the editor's on the five tracks, at timeline version `v`. */
const all = (v: number) => {
  const f = ["zoom", "pan", "tilt", "rot", "flip", "crop", "opacity", "speed", "gain_db", "fade_in", "fade_out", "enabled", "hidden", "mute"];
  return { edj_version: v, tracks: Object.fromEntries(["V1", "V2", "A1", "A2", "A3"].map((t) => [t, f])) };
};

describe("handCheck: the save's rules", () => {
  const nle = () => toNle(draft());
  it("takes a version-1 timeline, and reads it without changing it", () => {
    const tl = nle();
    const before = structuredClone(tl);
    expect(handCheck(tl, all(1))).toEqual([]);
    expect(tl).toEqual(before);
  });
  it("refuses version 2 where the renders take version 1, takes it where they take 2; an unknown version never", () => {
    const tl = nle();
    tl.tracks.V1.items[0]!.keys = { zoom: [[0, 1, "ease"], [30, 1.4, "linear"]] };
    expect(handCheck(tl, all(1))).toEqual([expect.stringContaining(NOT_RENDERED)]);
    expect(handCheck(tl, all(2))).toEqual([]);
    expect(handCheck({ ...nle(), edj_version: 3 }, all(2))[0]).toContain(NOT_RENDERED);
    expect(handCheck({ ...nle(), edj_version: "2" }, all(2))[0]).toContain("doesn't know");
    tl.tracks.V1.items[0]!.norm_db = 99;
    tl.tracks.V1.items[0]!.keys = { crop: [[0, 1, "ease"]] } as never;
    expect(handCheck(tl, all(2))).toEqual([expect.stringContaining("crop can't be keyed"), expect.stringContaining("norm_db 99")]);
  });
  it("names what would fail a render: frames, overlaps, past the file's end, a missing source, a transition with no room", () => {
    const tl = nle();
    tl.tracks.V1.items.push({ src: "ver_w", in: 880, len: 40, rec: 50 }, { src: "gone", in: 0, len: 10, rec: 200 }, { src: "ver_w", in: 0.5, len: 10, rec: 300 });
    const bad = handCheck(tl, all(1));
    expect(bad).toEqual([
      expect.stringContaining("starts on top of the clip before it on V1"),
      expect.stringContaining("runs 20 source frames past the end"),
      expect.stringContaining("its source isn't in the timeline"),
      expect.stringContaining("isn't a whole number of frames"),
    ]);
    const cut = nle();
    cut.tracks.V1.items.push({ src: "ver_w", in: 0, len: 30, rec: 60, trans: { type: "dissolve", len: 20, at: "center" } });
    expect(handCheck(cut, all(2))).toEqual([expect.stringContaining("transition needs more of the clips")]);
    expect(handCheck({ ...nle(), tracks: {} }, all(1))).toEqual(["there is nothing on the timeline"]);
  });
});

describe("what the renders don't draw", () => {
  const renders = { edj_version: 1, tracks: { V1: ["zoom", "tilt", "fade_in", "fade_out"], A1: ["gain_db"] } };
  it("names each track and field used that isn't drawn; a value that changes nothing counts as unused", () => {
    const tl = toNle(draft());
    // the draft: a wide take's zoom (drawn), tilt (drawn), A1 gain (drawn); A2 and A3 empty
    expect(unrendered(tl, renders)).toEqual([]);
    Object.assign(tl.tracks.V1.items[0]!, { rot: 0, opacity: 1, speed: 1, crop: [0, 0, 0, 0], rot2: 5 });
    expect(unrendered(tl, renders)).toEqual([]);
    Object.assign(tl.tracks.V1.items[0]!, { rot: 5, enabled: false });
    tl.tracks.A1.mute = true;
    tl.tracks.V3 = { items: [{ src: "ver_w", rec: 0, in: 0, len: 5 }] };
    expect(unrendered(tl, renders).sort()).toEqual(["A1 mute", "V1 enabled", "V1 rot", "V3"]);
  });
  it("the save refuses only what is new: a field the draft came with stays, one more is refused", () => {
    const base = toNle(draft());
    base.tracks.V1.items[0]!.speed = 1.5; // a planned edit's
    const tl = structuredClone(base);
    tl.tracks.V1.items[0]!.speed = 2;
    expect(handCheck(tl, renders, base)).toEqual([]);
    tl.tracks.V1.items[0]!.opacity = 0.5;
    expect(handCheck(tl, renders, base)).toEqual([`${NOT_RENDERED}: V1 opacity`]);
  });
});
