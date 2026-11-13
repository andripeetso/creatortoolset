import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { cleanEdits, playPlan, splitView, voicePieces, type ItemEdit } from "../../contracts/edit-timeline";
import { applyEdits, draftView, EditRefused } from "./edits";
import { emptyTracks } from "./timeline";

/** Three linked 30-frame shots (a 60 fps take on a 30 fps timeline), B-roll over the second and third, a marker on each shot. */
function three(): Timeline {
  const t: Timeline = {
    name: "t",
    fps: 30,
    width: 1080,
    height: 1920,
    sources: { A: { versionId: "A", name: "Take A", fps: 60, tc: 0, dur: 9000, w: 1080, h: 1920 }, R: { versionId: "R", name: "Roll", fps: 30, tc: 0, dur: 900, w: 1080, h: 1920 } },
    tracks: emptyTracks(),
    markers: [0, 30, 60].map((rec, k) => ({ rec, name: `L${k + 1}`, color: "BLUE", note: "" })),
  };
  for (const k of [0, 1, 2]) {
    t.tracks.V1.items.push({ src: "A", in: 100 + k * 100, len: 30, rec: k * 30, link: `c${k}` });
    t.tracks.A1.items.push({ src: "A", in: 100 + k * 100, len: 30, rec: k * 30, link: `c${k}` });
  }
  t.tracks.V2.items.push({ src: "R", in: 0, len: 40, rec: 40 });
  return t;
}
const at = (t: Timeline, track: "V1" | "A1" | "V2") => t.tracks[track].items.map((i) => [i.rec, i.len, i.in]);
const edit = (e: Partial<ItemEdit> & { key: string }): ItemEdit => ({ label: e.key, ...e });
/** As the route does: the edits as the server keeps them, then cut in. */
const make = (t: Timeline, ...edits: (Partial<ItemEdit> & { key: string })[]) => applyEdits(t, cleanEdits(edits.map(edit)));

describe("a draft on Review's timeline", () => {
  it("keys every item by its track and frame, with how far each edge can be pulled", () => {
    const v = draftView(three(), { A: [{ w: "Hello", s: 100 / 60, e: 2 }, { w: "there", s: 2, e: 2.5 }, { w: "later", s: 200 / 60 + 0.1, e: 200 / 60 + 0.4 }] });
    expect(v.tracks.map((t) => t.id)).toEqual(["V1", "V2", "A1"]);
    expect(v.duration).toBe(90);
    const shot = v.tracks[0]!.items[1]!;
    // the second shot starts 200 source frames in: 100 timeline frames of the take before it, the rest after
    expect(shot).toMatchObject({ key: "V1:30", rec: 30, len: 30, src: "A", ins: 3.333, before: 100, after: 4500 - 100 - 30, label: "later", detail: "Take A" });
    // a voice can't be pulled past its shot
    expect(v.tracks[2]!.items[1]).toMatchObject({ key: "A1:30", before: 0, after: 0 });
    expect(v.tracks[1]!.items[0]).toMatchObject({ key: "V2:40", label: "Roll", before: 0, after: 860 });
    expect(v.words).toEqual([{ t: "Hello", rs: 0, re: 10 }, { t: "there", rs: 10, re: 25 }, { t: "later", rs: 33, re: 42 }]);
    expect(v.markers[0]).toEqual({ frame: 0, name: "L1", color: "Blue" });
  });
});

describe("timeline edits made into a cut", () => {
  it("a shot taken out goes with its voice, and everything after moves up", () => {
    const before = three();
    const t = make(before, { key: "V1:30", remove: true });
    expect(at(t, "V1")).toEqual([[0, 30, 100], [30, 30, 300]]);
    expect(at(t, "A1")).toEqual(at(t, "V1"));
    // B-roll 40-80 over the removed 30-60: what is left of it plays what it played there (20 frames in)
    expect(at(t, "V2")).toEqual([[30, 20, 20]]);
    expect(t.markers.map((m) => m.rec)).toEqual([0, 30, 30]);
    expect(at(before, "V1")).toHaveLength(3); // the input is untouched
  });

  it("an edge pulled in takes those words out; B-roll over it gets shorter at its end, its clip unbroken", () => {
    const t = make(three(), { key: "V1:30", tail: -10 });
    expect(at(t, "V1")).toEqual([[0, 30, 100], [30, 20, 200], [50, 30, 300]]);
    expect(at(t, "A1")).toEqual(at(t, "V1"));
    expect(at(t, "V2")).toEqual([[40, 30, 0]]);
    const h = make(three(), { key: "V1:30", head: -10 });
    expect(at(h, "V1")).toEqual([[0, 30, 100], [30, 20, 220], [50, 30, 300]]);
  });

  it("an edge pulled out shows more of the take with its voice, and the rest moves later", () => {
    const t = make(three(), { key: "V1:30", head: 6, tail: 4 });
    // 6 timeline frames earlier in a 60 fps take = 12 source frames
    expect(at(t, "V1")).toEqual([[0, 30, 100], [30, 40, 188], [70, 30, 300]]);
    expect(at(t, "A1")).toEqual(at(t, "V1"));
    // the B-roll that started 10 frames into that shot still does, and covers the frames gained under it
    expect(at(t, "V2")).toEqual([[46, 44, 0]]);
    expect(t.markers.map((m) => m.rec)).toEqual([0, 30, 70]);
  });

  it("a voice pulled in or taken out leaves the picture playing silent there", () => {
    const t = make(three(), { key: "A1:30", tail: -10 }, { key: "A1:0", remove: true });
    // the second shot is cut where its voice stops: 20 frames with it, 10 without
    expect(at(t, "V1")).toEqual([[0, 30, 100], [30, 20, 200], [50, 10, 240], [60, 30, 300]]);
    expect(at(t, "A1")).toEqual([[30, 20, 200], [60, 30, 300]]);
    const linked = t.tracks.V1.items.filter((v) => v.link).map((v) => v.rec);
    expect(linked).toEqual([30, 60]);
    for (const a of t.tracks.A1.items) expect(t.tracks.V1.items.find((v) => v.link === a.link)).toMatchObject({ rec: a.rec, len: a.len, in: a.in });
  });

  it("a cut makes two shots, each with its voice; one of them can go", () => {
    const t = make(three(), { key: "V1:30", split: [45] }, { key: "V1:45", remove: true });
    expect(at(t, "V1")).toEqual([[0, 30, 100], [30, 15, 200], [45, 30, 300]]);
    expect(at(t, "A1")).toEqual(at(t, "V1"));
    expect(at(make(three(), { key: "V1:30", split: [45] }), "V1")).toEqual([[0, 30, 100], [30, 15, 200], [45, 15, 230], [60, 30, 300]]);
  });

  it("B-roll moves, slips, trims and copies; one dropped on another takes its place there", () => {
    const t = three();
    t.tracks.V2.items.unshift({ src: "R", in: 500, len: 20, rec: 5 });
    expect(at(make(t, { key: "V2:40", move: 10, slip: 5, tail: -10 }), "V2")).toEqual([[5, 20, 500], [50, 30, 5]]);
    // moved 25 frames earlier it covers 15-55: the first clip keeps 5-15
    expect(at(make(t, { key: "V2:40", move: -25 }), "V2")).toEqual([[5, 10, 500], [15, 40, 0]]);
    // a copy (its key is where it goes) beside the one it copies
    expect(at(make(three(), { key: "V2:0", copyOf: "V2:40", tail: -10 }), "V2")).toEqual([[0, 30, 0], [40, 40, 0]]);
    expect(at(make(t, { key: "V2:5", remove: true }), "V2")).toEqual([[40, 40, 0]]);
  });

  it("plays what Review's player showed: the frames it skipped are gone, the frames it held are gained", () => {
    const edits = cleanEdits([{ key: "V1:0", tail: -7 }, { key: "V1:30", head: 5, split: [44] }, { key: "V1:44", remove: true }, { key: "V1:60", tail: 9 }].map(edit));
    const t = three();
    const view = splitView(draftView(t), edits);
    const plan = playPlan(view, edits);
    const out = applyEdits(t, edits);
    const gone = plan.skips.reduce((n, [a, b]) => n + b - a, 0);
    const held = plan.holds.reduce((n, h) => n + h.frames, 0);
    const shots = out.tracks.V1.items;
    expect(shots.reduce((n, s) => n + s.len, 0)).toBe(90 - gone + held);
    // end to end, nothing over anything
    expect(shots.map((s) => s.rec)).toEqual(shots.map((_, k) => shots.slice(0, k).reduce((n, s) => n + s.len, 0)));
    // every voice is its shot's: the same frames of the same take
    for (const a of out.tracks.A1.items) expect(shots.find((v) => v.link === a.link)).toMatchObject({ rec: a.rec, len: a.len, in: a.in, src: a.src });
    expect(Object.keys(out.sources).sort()).toEqual(["A", "R"]);
  });

  it("puts every voice where Review's player plays it from the recording", () => {
    // cuts, a shot out, edges pulled in and a voice pulled in. (A shot pulled out takes its voice along in the cut; the
    // player keeps that stretch silent until the voice is pulled out too, so it is not in this comparison.)
    const edits = cleanEdits([{ key: "V1:0", tail: -7 }, { key: "V1:30", split: [44] }, { key: "V1:44", remove: true }, { key: "A1:60", head: -5 }, { key: "V1:60", tail: -3 }].map(edit));
    const t = three();
    const view = splitView(draftView(t), edits);
    const played = voicePieces(view, edits, playPlan(view, edits));
    // the cut's voice clips as the player's pieces: a clip that runs on from the one before, in time and in the take, is one
    const mine: { src: string; at: number; frames: number; offset: number }[] = [];
    for (const a of applyEdits(t, edits).tracks.A1.items) {
      const last = mine.at(-1);
      if (last && last.at + last.frames === a.rec && Math.abs(last.offset + last.frames / 30 - a.in / 60) < 1e-6) last.frames += a.len;
      else mine.push({ src: a.src, at: a.rec, frames: a.len, offset: a.in / 60 });
    }
    expect(mine.map((p) => [p.src, p.at, p.frames])).toEqual(played.map((p) => [p.src, p.at, p.frames]));
    mine.forEach((p, k) => expect(p.offset).toBeCloseTo(played[k]!.offset, 3));
    expect(mine.length).toBeGreaterThan(2);
  });

  it("refuses what it can't make, naming each edit, and makes nothing", () => {
    const refused = (...e: ItemEdit[]) => {
      try {
        applyEdits(three(), e);
      } catch (err) {
        expect(err).toBeInstanceOf(EditRefused);
        return (err as Error).message;
      }
      return "";
    };
    expect(refused(edit({ key: "V1:31", label: "Old shot", remove: true }))).toBe("Old shot is not on this version's timeline");
    expect(refused(edit({ key: "A1:30", label: "Voice", move: 4 }), edit({ key: "V2:40", label: "Roll", track: "V3" })))
      .toBe("Voice: a voice stays with its picture, it can only be cut or taken out. Roll: this editor has no layer V3");
    expect(refused(edit({ key: "V1:0", label: "Hook", grade: { exposure: 1 } as never }))).toContain("a colour change");
    expect(refused(edit({ key: "V1:0", label: "Hook", head: 60 }))).toBe("Hook: its footage has no more there");
    expect(refused(...["V1:0", "V1:30", "V1:60"].map((key) => edit({ key, remove: true })))).toBe("Nothing would be left of the cut");
  });
});
