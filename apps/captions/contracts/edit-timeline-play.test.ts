import { describe, expect, it } from "vitest";
import { cleanEdits, describeEdit, editedFrame, picturePieces, playPlan, rateAt, renderPieces, splitView, voicePieces, type ItemEdit, type TimelineView } from "./edit-timeline";

// The first three shots of a real AI edit (25 fps): each talent shot's voice is its own recording (R<k>vo), `ins` = the
// in point in seconds. Shot 2 is the one whose voice was pulled out on Review's timeline.
const view: TimelineView = {
  name: "Tiny story", fps: 25, duration: 327, width: 2160, height: 3840, markers: [], words: [], flags: [],
  tracks: [
    { id: "V1", name: "TALENT", items: [
      { key: "V1:0", track: "V1", rec: 0, len: 149, label: "B01", src: "R3", ins: 9.36 },
      { key: "V1:149", track: "V1", rec: 149, len: 77, label: "B02", src: "R1", ins: 0 },
      { key: "V1:226", track: "V1", rec: 226, len: 54, label: "B02", src: "R1", ins: 3.44 },
    ] },
    { id: "A1", name: "VO", items: [
      { key: "A1:0", track: "A1", rec: 0, len: 149, label: "VO", src: "R3vo", ins: 9.36 },
      { key: "A1:149", track: "A1", rec: 149, len: 77, label: "VO", src: "R1vo", ins: 0 },
      { key: "A1:226", track: "A1", rec: 226, len: 54, label: "VO", src: "R1vo", ins: 3.44 },
    ] },
  ],
};
const e = (key: string, x: Partial<ItemEdit>): ItemEdit => ({ key, label: key, ...x });
const pieces = (edits: ItemEdit[]) => voicePieces(splitView(view, edits), edits, playPlan(splitView(view, edits), edits));

describe("playing the edit from its originals", () => {
  it("plays the cut as it is when nothing changed", () => {
    expect(pieces([])).toEqual([
      { src: "R3vo", at: 0, frames: 149, offset: 9.36 },
      { src: "R1vo", at: 149, frames: 77, offset: 0 },
      { src: "R1vo", at: 226, frames: 54, offset: 3.44 },
    ]);
  });

  it("a shot made longer with its voice plays the recording's next words in the hold, and the rest comes after it", () => {
    const edits = [e("V1:149", { tail: 10 }), e("A1:149", { tail: 10 })];
    const plan = playPlan(view, edits);
    expect(plan.holds).toEqual([{ at: 225, frames: 10 }]);
    expect(editedFrame(plan, 225)).toBe(225);
    expect(editedFrame(plan, 226)).toBe(236);
    expect(pieces(edits)).toEqual([
      { src: "R3vo", at: 0, frames: 149, offset: 9.36 },
      { src: "R1vo", at: 149, frames: 87, offset: 0 }, // 77 frames of the cut, then 10 more of the recording
      { src: "R1vo", at: 236, frames: 54, offset: 3.44 },
    ]);
  });

  it("a voice pulled out at its start plays the recording from earlier, never before its first second", () => {
    expect(pieces([e("A1:226", { head: 20 })])[2]).toEqual({ src: "R1vo", at: 206, frames: 74, offset: 2.64 });
    expect(pieces([e("A1:149", { head: 30 })])[1]).toEqual({ src: "R1vo", at: 149, frames: 77, offset: 0 });
  });

  it("what the picture skips is cut from the voice and the sound after it moves up", () => {
    const edits = [e("V1:149", { remove: true })];
    expect(pieces(edits)).toEqual([
      { src: "R3vo", at: 0, frames: 149, offset: 9.36 },
      { src: "R1vo", at: 149, frames: 54, offset: 3.44 },
    ]);
    expect(renderPieces(playPlan(view, edits), 280, 25)).toEqual([
      { src: "render", at: 0, frames: 149, offset: 0 },
      { src: "render", at: 149, frames: 54, offset: 226 / 25 },
    ]);
  });

  it("a removed voice is silent and a moved one plays later from the same words", () => {
    expect(pieces([e("A1:149", { remove: true })]).map((p) => p.at)).toEqual([0, 226]);
    expect(pieces([e("A1:226", { move: 12 })])[2]).toEqual({ src: "R1vo", at: 238, frames: 54, offset: 3.44 });
  });

  it("a talent shot made longer plays its camera original past the cut's end, framed as cut, and B-roll still shows from the render", async () => {
    const withRoll: TimelineView = { ...view, tracks: [
      { ...view.tracks[0], items: view.tracks[0].items.map((i) => (i.key === "V1:149" ? { ...i, zoom: 1.3, tilt: 40 } : i)) },
      view.tracks[1],
      { id: "V2", name: "B-ROLL", items: [{ key: "V2:20", track: "V2", rec: 20, len: 30, label: "roll" }] },
    ] };
    const edits = [e("V1:149", { tail: 10 }), e("V1:226", { head: 5 })];
    const plan = playPlan(withRoll, edits);
    expect(picturePieces(splitView(withRoll, edits), edits, plan).map(({ key, at, frames, offset, zoom }) => [key, at, frames, offset, zoom])).toEqual([
      ["V1:0", 0, 20, 9.36, 1],
      ["V1:0", 50, 99, 11.36, 1], // under the B-roll the render shows
      ["V1:149", 149, 87, 0, 1.3], // 77 frames of the cut and 10 more of the take
      ["V1:226", 236, 59, 3.24, 1], // made 5 frames longer at its start: the take's 5 frames before it, then the shot
    ]);
  });

  it("the picture is the topmost switched-on clip, from its file: a talent copy over a switched-off take plays and runs on past its cut", () => {
    const layered: TimelineView = { ...view, tracks: [
      { id: "V1", name: "TALENT (original)", items: [{ key: "V1:0", track: "V1", rec: 0, len: 100, label: "take", src: "raw", ins: 0, off: true }] },
      { id: "V2", name: "TALENT", items: [{ key: "V2:0", track: "V2", rec: 0, len: 100, label: "copy", src: "copy", ins: 1 }] },
      { id: "V3", name: "CARDS", items: [{ key: "V3:40", track: "V3", rec: 40, len: 20, label: "title" }] },
    ] };
    const edits = [e("V2:0", { tail: 10 })];
    const plan = playPlan(layered, edits);
    const got = picturePieces(splitView(layered, edits), edits, plan).map(({ key, at, frames, offset }) => [key, at, frames, offset]);
    // the card (no file) hides the copy under it: the render shows it there; the switched-off take never shows
    expect(got).toEqual([["V2:0", 0, 40, 1], ["V2:0", 60, 50, 3.4]]);
    // a clip whose file can't be played gives nothing, and doesn't let the layer under it show through
    expect(picturePieces(splitView(layered, edits), edits, plan, (s) => s !== "copy")).toEqual([]);
  });
});


describe("a talent shot played faster or slower (speed)", () => {
  it("is kept on a talent shot only, 50 to 200 %, and said in words", () => {
    const kept = cleanEdits([
      { key: "V1:0", label: "fast", speed: 1.5 }, { key: "V2:0", label: "overlay", speed: 2 }, { key: "A1:0", label: "voice", speed: 2 },
      { key: "V1:149", label: "too fast", speed: 3 }, { key: "V1:226", label: "as it is", speed: 1 },
    ]);
    expect(kept).toEqual([{ key: "V1:0", label: "fast", speed: 1.5 }]);
    expect(describeEdit(kept[0], 25)).toBe("plays at 150 % with its voice, what follows moves up");
  });

  it("at 2× the shot and its voice take half the frames, from the same words, and everything after moves up", () => {
    const edits = [e("V1:149", { speed: 2 })];
    const plan = playPlan(splitView(view, edits), edits);
    expect(plan.rates).toEqual([{ from: 149, to: 226, rate: 2 }]);
    expect(rateAt(plan, 150)).toBe(2);
    expect(rateAt(plan, 226)).toBe(1);
    expect(editedFrame(plan, 149)).toBe(149);
    expect(editedFrame(plan, 226)).toBe(187.5); // 77 frames at 2× = 38.5
    expect(pieces(edits)).toEqual([
      { src: "R3vo", at: 0, frames: 149, offset: 9.36 },
      { src: "R1vo", at: 149, frames: 38.5, offset: 0, rate: 2 },
      { src: "R1vo", at: 187.5, frames: 54, offset: 3.44 },
    ]);
    // the cut's own sound and the picture follow the same clock
    expect(renderPieces(plan, 280, 25)).toEqual([
      { src: "render", at: 0, frames: 149, offset: 0 },
      { src: "render", at: 149, frames: 38.5, offset: 5.96, rate: 2 },
      { src: "render", at: 187.5, frames: 54, offset: 9.04 },
    ]);
    expect(picturePieces(splitView(view, edits), edits, plan).find((p) => p.key === "V1:149"))
      .toMatchObject({ src: "R1", at: 149, frames: 38.5, offset: 0, rate: 2 });
  });

  it("a slower shot (50 %) takes twice the frames", () => {
    expect(editedFrame(playPlan(view, [e("V1:226", { speed: 0.5 })]), 280)).toBe(334);
  });
});
