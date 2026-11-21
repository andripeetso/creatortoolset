import { describe, expect, it } from "vitest";
import type { LineTakes, TakeCut } from "@contracts/editor";
import { clipFor, lineOf, swapTake, takeRows } from "./editor-takes";
import { withKeys, type NleTimeline } from "./nle/model";

// The take picker on a draft as the draft step lays it: a marker per line, pictures on V1 with their sound on A1, linked.

const lines = ["L1", "L2"];
const src = { versionId: "rec1", name: "rec1", fps: 25, tc: 0, dur: 2500, w: 1080, h: 1920 };
function draft(): NleTimeline {
  return withKeys({
    timeline: { fps: 25, width: 1080, height: 1920 },
    sources: { rec1: { ...src } },
    tracks: {
      V1: { items: [
        { src: "rec1", rec: 0, len: 50, in: 200, link: "c1", zoom: 1.3 },
        { src: "rec1", rec: 50, len: 30, in: 400, link: "c2" },
      ] },
      // B-roll starting inside L1 and running over its end
      V2: { items: [{ src: "broll", rec: 40, len: 20, in: 0 }] },
      A1: { items: [
        { src: "rec1", rec: 0, len: 50, in: 200, link: "c1", processing: { voice: "enhance" }, norm_db: 3, gain_db: -2 },
        { src: "rec1", rec: 50, len: 30, in: 400, link: "c2" },
      ] },
      // a music bed under everything
      A2: { items: [{ src: "song", rec: 0, len: 80, in: 0 }] },
    },
    markers: [{ frame: 0, name: "L1", color: "Blue" }, { frame: 50, name: "L2", color: "Blue" }, { frame: 70, name: "mine", color: "Red" }],
  });
}
const take = (first: number, cut: [number, number][], s = "rec1"): TakeCut => ({ first, last: first, score: 1, src: s, s: cut[0]![0] / 25, e: cut.at(-1)![1] / 25, cut });
const keyOf = (tl: NleTimeline, track: string, i: number) => tl.tracks[track]!.items[i]!._k!;

describe("take picker", () => {
  it("a picked sound stands for its picture; B-roll has no line; nothing picked shows nothing", () => {
    const tl = draft();
    expect(clipFor(tl, [])).toBeNull();
    const c = clipFor(tl, [keyOf(tl, "A1", 1)])!;
    expect([c.track, lineOf(tl, c.item, lines)]).toEqual(["V1", "L2"]);
    expect(lineOf(tl, tl.tracks.V1!.items[0]!, lines)).toBe("L1");
    expect(clipFor(tl, [keyOf(tl, "V2", 0)])!.track).toBe("V2");
  });

  it("names the take the clip plays and the other versions that use each take", () => {
    const tl = draft();
    const lt: LineTakes = { line: "L1", text: "so this is it", sources: {}, takes: [take(7, [[600, 640]]), take(3, [[190, 260]])] };
    const e = { plans: [
      { name: "v1", title: "Hook first", lines: [{ line: "L1", take: { first: 3, last: 3, score: 1 } }] },
      { name: "v2", title: "Story", lines: [{ line: "L1", take: { first: 7, last: 7, score: 1 } }] },
    ] };
    const rows = takeRows(e, "v1", tl, tl.tracks.V1!.items[0]!, lt);
    expect(rows.map((r) => [r.n, r.here, r.used])).toEqual([[1, false, ["B"]], [2, true, []]]);
  });

  it("a longer take ripples what comes after; the sound is the take as recorded, with no effect on it", () => {
    const tl = draft();
    const next = swapTake(tl, "L1", lines, take(7, [[600, 640], [660, 690]]), undefined);
    const v1 = next.tracks.V1!.items;
    expect(v1.map((i) => [i.rec, i.len, i.in])).toEqual([[0, 40, 600], [40, 30, 660], [70, 30, 400]]);
    expect(v1[0]!.zoom).toBe(1.3); // same recording: its framing stays
    const a1 = next.tracks.A1!.items;
    expect(a1.map((i) => [i.rec, i.len, i.in, i.link === v1[a1.indexOf(i)]!.link])).toEqual([[0, 40, 600, true], [40, 30, 660, true], [70, 30, 400, true]]);
    expect(a1[0]!.processing).toBeUndefined();
    expect(a1[0]!.norm_db).toBeUndefined();
    expect(a1[0]!.gain_db).toBe(-2); // its level stays
    expect(next.tracks.V2!.items[0]!.rec).toBe(60); // B-roll over the line's end moves with it
    expect(next.tracks.A2!.items[0]!.len).toBe(100); // the bed grows with the line
    expect(next.markers!.map((m) => [m.name, m.frame])).toEqual([["L1", 0], ["L2", 70], ["mine", 90]]);
    expect(tl.tracks.V1!.items[0]!.in).toBe(200); // the timeline it came from is untouched
  });

  it("a shorter take on another recording pulls what comes after up and drops the old framing", () => {
    const tl = draft();
    const other = { ...src, versionId: "rec2", name: "rec2" };
    const next = swapTake(tl, "L1", lines, take(9, [[100, 120]], "rec2"), other);
    expect(next.sources.rec2).toMatchObject({ versionId: "rec2" });
    expect(next.tracks.V1!.items.map((i) => [i.src, i.rec, i.len, i.zoom])).toEqual([["rec2", 0, 20, undefined], ["rec1", 20, 30, undefined]]);
    expect(next.markers!.find((m) => m.name === "L2")!.frame).toBe(20);
  });

  it("refuses a line whose voice isn't linked, or isn't flush with the picture, and a recording it can't find", () => {
    const unlinked = draft();
    delete unlinked.tracks.A1!.items[0]!.link;
    expect(() => swapTake(unlinked, "L1", lines, take(7, [[600, 640]]), undefined)).toThrow(/isn't linked/);
    const jcut = draft();
    jcut.tracks.A1!.items[0]!.len = 45;
    expect(() => swapTake(jcut, "L1", lines, take(7, [[600, 640]]), undefined)).toThrow(/don't start together/);
    expect(() => swapTake(draft(), "L1", lines, take(9, [[100, 120]], "rec9"), undefined)).toThrow(/isn't in the edit's footage/);
  });
});
