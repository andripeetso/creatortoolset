import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { importTimeline, TimelineError } from "../contracts/timeline-import";

// The AI Editor's hand-over packages (OTIO, FCP 7 XML, FCPXML and one EDL per video track, written from a draft)
// read back through Review's parser. The fixtures are sample exports of one draft. What Review must see, from the draft:
//   V1 TALENT      talk.mp4 0+100, talk.mp4 100+100
//   V2 B-ROLL      bro.mov 100+50
//   V3 MOTION GFX  card.mov 20+30, g_%05d.png 60+3 (an image sequence: a missing reference in the adapters)
//   V4 CAPTIONS    L01.mov 0+50, disabled (the track is off)
//   A1 VO          talk.mp4 0+100 (gain +2 dB, linked to V1's first clip)
// Review draws V tracks top down and lists them before A tracks (V4 V3 V2 V1 A1).
const FIX = path.resolve(import.meta.dirname, "fixtures/handover");
const read = (rel: string) => readFileSync(path.join(FIX, rel), "utf8");

type Shape = [string, [number, number, string, "on" | "off"][]][];
const shape = (v: ReturnType<typeof importTimeline>): Shape =>
  v.tracks.map((t) => [
    t.id,
    t.items.map((i) => [i.rec, i.len, i.label, /disabled/.test(i.detail ?? "") ? "off" : "on"]),
  ]);

const FULL: Shape = [
  ["V4", [[0, 50, "L01.mov", "off"]]],
  ["V3", [[20, 30, "card.mov", "on"], [60, 3, "g_%05d.png", "on"]]],
  ["V2", [[100, 50, "bro.mov", "on"]]],
  ["V1", [[0, 100, "talk.mp4", "on"], [100, 100, "talk.mp4", "on"]]],
  ["A1", [[0, 100, "talk.mp4", "on"]]],
];

// The source-in each format's first V1 clip (talk.mp4 at in 10) must read back as, from its own detail text.
const sourceIn = (v: ReturnType<typeof importTimeline>, track: string, n: number) =>
  v.tracks.find((t) => t.id === track)?.items[n]?.detail?.match(/source (\S+)/)?.[1];

describe("hand-over packages through Review's timeline import", () => {
  it("source ranges survive in every format (talk.mp4 in 10 = 00:00:00:10)", () => {
    const otio = importTimeline("Tiny_V1A_D1.otio", read("otio-resolve/Tiny_V1A_D1.otio"));
    const fcp7 = importTimeline("Tiny_V1A_D1.xml", read("fcp7-premiere/Tiny_V1A_D1.xml"));
    const fcpx = importTimeline("Tiny_V1A_D1.fcpxml", read("fcpx-final-cut/Tiny_V1A_D1.fcpxml"));
    const edl = importTimeline("Tiny_V1A_D1.V1.edl", read("edl/Tiny_V1A_D1.V1.edl"), 25);
    for (const v of [otio, fcp7, fcpx, edl]) expect(sourceIn(v, "V1", 0)).toBe("00:00:00:10");
    expect(sourceIn(otio, "V2", 0)).toBe("00:00:00:00");   // bro.mov in 0
    expect(sourceIn(fcpx, "V1", 1)).toBe("00:00:04:10");   // second talk clip: in 110
  });

  it("OTIO (Resolve's dialect): every track, clip, disabled track and the 25 fps timeline", () => {
    const v = importTimeline("Tiny_V1A_D1.otio", read("otio-resolve/Tiny_V1A_D1.otio"));
    expect(v.fps).toBe(25);
    expect(shape(v)).toEqual(FULL);
    expect(v.markers).toEqual([{ frame: 0, name: "HOOK", color: "Red" }]);
  });

  it("FCP 7 XML (Premiere, free Resolve): clips, order, disabled items", () => {
    const v = importTimeline("Tiny_V1A_D1.xml", read("fcp7-premiere/Tiny_V1A_D1.xml"));
    expect(v.fps).toBe(25);
    expect(shape(v)).toEqual(FULL);
  });

  it("FCPXML (Final Cut): spine, connected lanes, the audio on its own lane, disabled clips", () => {
    const v = importTimeline("Tiny_V1A_D1.fcpxml", read("fcpx-final-cut/Tiny_V1A_D1.fcpxml"));
    expect(v.fps).toBe(25);
    expect(shape(v)).toEqual(FULL);
  });

  it("EDL: one file per video track; each reads back as its own V1 with the cut", () => {
    const edl = (n: string) => importTimeline(`${n}.edl`, read(`edl/Tiny_V1A_D1.${n}.edl`), 25);
    expect(shape(edl("V1"))).toEqual([["V1", [[0, 100, "talk.mp4", "on"], [100, 100, "talk.mp4", "on"]]]]);
    expect(shape(edl("V2"))).toEqual([["V1", [[100, 50, "bro.mov", "on"]]]]);
    expect(shape(edl("V3"))).toEqual([["V1", [[20, 30, "card.mov", "on"], [60, 3, "g_%05d.png", "on"]]]]);
  });

  it("refuses a file that isn't one of the hand-over formats", () => {
    expect(() => importTimeline("notes.txt", "hello")).toThrow(TimelineError);
  });
});

// The packages name their files relative to the package (media/talk.mp4): no file to play, but where each clip starts in
// it and its media room are there, the same in every format (talk.mp4 at in 10 of 500 frames, 100 long).
it("hand-over packages: the talent clip's place in its file, in every format", () => {
  for (const [name, rel] of [["Tiny_V1A_D1.otio", "otio-resolve"], ["Tiny_V1A_D1.xml", "fcp7-premiere"], ["Tiny_V1A_D1.fcpxml", "fcpx-final-cut"]]) {
    const v = importTimeline(name, read(`${rel}/${name}`));
    const first = (id: string) => v.tracks.find((t) => t.id === id)!.items[0];
    expect(first("V1"), name).toMatchObject({ ins: 0.4, before: 10, after: 390 });
    expect(first("V1").src, name).toBeUndefined();
    expect(first("A1").ins, name).toBe(0.4);
  }
});
