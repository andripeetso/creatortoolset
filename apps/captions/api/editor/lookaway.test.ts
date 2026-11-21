import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { BROLL_NOTE, placeBroll } from "./broll";
import { baseline, onScreen, parseGaze, stretches, subtract, type GazeSample } from "./lookaway";
import { emptyTracks } from "./timeline";

const ahead: GazeSample = [2, -3, 0.5];
const turned: GazeSample = [20, -3, 0.5];
const reading: GazeSample = [2, 7, 0.5];

describe("look-aways", () => {
  it("reads each take against its own straight-ahead pose: a run of four away samples or more is a look-away", () => {
    // samples 6 frames apart: 0..3 ahead, 4..8 turned (5), 9 ahead, 10..12 reading (only 3), 13 ahead, 14..17 no face (4)
    const samples = [...Array(4).fill(ahead), ...Array(5).fill(turned), ahead, ...Array(3).fill(reading), ahead, ...Array(4).fill(null), ...Array(10).fill(ahead)];
    expect(baseline(samples)).toEqual([2, -3, 0.5]);
    expect(stretches({ fps: 25, step: 6, samples })).toEqual([[24, 49], [84, 103]]);
    // the eyes alone leaving the lens count too
    expect(stretches({ fps: 25, step: 6, samples: [...Array(10).fill(ahead), ...Array(4).fill([2, -3, 0.7])] })).toEqual([[60, 79]]);
    // a take with no face anywhere: nothing tells where its lens is
    expect(stretches({ fps: 25, step: 6, samples: Array(10).fill(null) })).toEqual([]);
  });

  it("maps a take's look-aways onto the cut through the shots that show them", () => {
    const tracks = emptyTracks();
    tracks.V1.items = [
      { src: "a", in: 100, len: 50, rec: 0 },
      { src: "a", in: 400, len: 60, rec: 50 },
    ];
    const tl: Timeline = { name: "t", fps: 30, width: 1080, height: 1920, sources: { a: { versionId: "a", name: "A", fps: 60, tc: 0, dur: 9000, w: 1080, h: 1920 } }, tracks, markers: [] };
    // a at 60 fps on a 30 fps cut: a source frame is half a timeline frame
    expect(onScreen(tl, { a: [[120, 160], [380, 420], [700, 800]] })).toEqual([[10, 30], [50, 60]]);
    expect(subtract([[0, 100]], [[10, 20], [90, 120]])).toEqual([[0, 10], [20, 90]]);
  });

  it("takes only samples from a computer", () => {
    expect(parseGaze({ fps: 25, step: 6, samples: [ahead, null] })).toEqual({ fps: 25, step: 6, samples: [ahead, null] });
    expect(parseGaze({ fps: 25, step: 6, samples: [[1, 2]] })).toBeNull();
    expect(parseGaze({ fps: 0, step: 6, samples: [] })).toBeNull();
    expect(parseGaze({ fps: 25, step: 1.5, samples: [] })).toBeNull();
    expect(parseGaze(null)).toBeNull();
  });
});

describe("B-roll covers the look-aways edge to edge", () => {
  /** His shots at 0, 90, 180, 300 (30 fps); the CTA line from 300. */
  function cut(): Timeline {
    const tracks = emptyTracks();
    tracks.V1.items = [0, 90, 180, 300].map((rec, k, all) => ({ src: "talk", in: rec, len: (all[k + 1] ?? 360) - rec, rec }));
    return {
      name: "t", fps: 30, width: 1080, height: 1920, tracks,
      sources: { talk: { versionId: "talk", name: "Talk", fps: 30, tc: 0, dur: 1000, w: 1080, h: 1920 } },
      markers: [0, 300].map((rec, n) => ({ rec, name: `L${n + 1}`, color: "BLUE", note: "" })),
    };
  }
  const pool = ["c1", "c2", "c3"].map((id) => ({ versionId: id, name: id, fps: 30, tc: 0, dur: 600, w: 1920, h: 1080 }));
  const covered = (tl: Timeline, a: number, b: number) => {
    for (let f = a; f < b; f++) if (!tl.tracks.V2.items.some((i) => i.rec <= f && f < i.rec + i.len)) return false;
    return true;
  };

  it("covers every look-away outside the hook and the CTA, with no sliver of face beside a cutaway", () => {
    const tl = cut();
    // without look-aways: the usual cutaways (one per shot, ending on his cuts)
    const plain = placeBroll(tl, pool).timeline.tracks.V2.items.map((i) => [i.rec, i.rec + i.len]);
    expect(plain).toEqual([[44, 90], [114, 180], [228, 300]]);
    // eyes off the lens at 95..125: the cutaway at 114 covers its end, its start would leave a sliver of face after 90
    const { timeline, notes } = placeBroll(tl, pool, [[95, 125], [20, 30], [310, 340]]);
    expect(covered(timeline, 95, 125)).toBe(true);
    // edge to edge: the cover starts on his cut at 90 and runs into the next cutaway
    expect(timeline.tracks.V2.items.map((i) => [i.rec, i.rec + i.len])).toEqual([[44, 90], [90, 114], [114, 180], [228, 300]]);
    // no clip moment used twice
    const used = timeline.tracks.V2.items.map((i) => `${i.src}:${i.in}`);
    expect(new Set(used).size).toBe(used.length);
    expect(notes).toEqual([`${BROLL_NOTE}the eyes leave the lens in the hook or the call to action, kept on the face: 0.7–1.0 s, 10.3–11.3 s`]);
  });

  it("a long look-away is covered in shots no longer than the longest cutaway; one no clip can cover is noted", () => {
    // one long shot of him, the CTA from 590
    const tl = cut();
    tl.tracks.V1.items = [{ src: "talk", in: 0, len: 600, rec: 0 }];
    tl.markers = [0, 590].map((rec, n) => ({ rec, name: `L${n + 1}`, color: "BLUE", note: "" }));
    const { timeline } = placeBroll(tl, pool, [[100, 400]]);
    expect(covered(timeline, 100, 400)).toBe(true);
    const cover = timeline.tracks.V2.items.filter((i) => i.rec < 400);
    expect(cover.map((i) => [i.rec, i.len])).toEqual([[100, 60], [160, 60], [220, 60], [280, 60], [340, 60]]);
    const left = placeBroll(tl, [{ ...pool[0]!, dur: 50 }], [[100, 400]]);
    expect(left.notes).toContain(`${BROLL_NOTE}no clip is left to cover the eyes off the lens at 3.3–13.3 s`);
  });
});
