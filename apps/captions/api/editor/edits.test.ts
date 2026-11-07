import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { move, remove, setFraming, slip, split, trim } from "./edits";
import { emptyTracks } from "./timeline";

/** Three linked 30-frame shots, B-roll over the second and third, a marker on each shot. */
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
    t.tracks.V1.items.push({ src: "A", in: k * 100, len: 30, rec: k * 30, link: `c${k}` });
    t.tracks.A1.items.push({ src: "A", in: k * 100, len: 30, rec: k * 30, link: `c${k}` });
  }
  t.tracks.V2.items.push({ src: "R", in: 0, len: 40, rec: 40 });
  return t;
}
const at = (t: Timeline, track: "V1" | "A1" | "V2") => t.tracks[track].items.map((i) => [i.rec, i.len, i.in]);

describe("AI Editor timeline edits", () => {
  it("remove takes the shot and its voice out and ripples every track and marker", () => {
    const before = three();
    const t = remove(before, "V1", 45);
    expect(at(t, "V1")).toEqual([[0, 30, 0], [30, 30, 200]]);
    expect(at(t, "A1")).toEqual([[0, 30, 0], [30, 30, 200]]);
    // B-roll 40-80 over the removed 30-60: its part after the gap stays, from 30 (20 frames in, at 30 fps)
    expect(at(t, "V2")).toEqual([[30, 20, 20]]);
    expect(t.markers.map((m) => m.rec)).toEqual([0, 30, 30]);
    expect(at(before, "V1")).toHaveLength(3); // pure: the input is untouched
    expect(at(remove(before, "V1", 45, false), "V1")).toEqual([[0, 30, 0], [60, 30, 200]]);
  });

  it("split cuts a shot and its voice in two, the second half on in the source at its own rate", () => {
    const t = split(three(), "A1", 10);
    expect(at(t, "V1").slice(0, 2)).toEqual([[0, 10, 0], [10, 20, 20]]);
    expect(at(t, "A1").slice(0, 2)).toEqual([[0, 10, 0], [10, 20, 20]]);
    expect(t.tracks.V1.items[1]!.link).toBe(t.tracks.A1.items[1]!.link);
    expect(t.tracks.V1.items[1]!.link).not.toBe(t.tracks.V1.items[0]!.link);
  });

  it("trim, slip, move and framing change only what they name", () => {
    const t = trim(three(), "V1", 0, 5, 0);
    expect(at(t, "V1")).toEqual([[0, 25, 10], [25, 30, 100], [55, 30, 200]]);
    expect(at(slip(three(), "V1", 0, 7), "A1")[0]).toEqual([0, 30, 7]);
    expect(() => move(three(), "V1", 0, 20)).toThrow(/taken/);
    expect(setFraming(three(), "V1", 0, { zoom: 1.2, tilt: 30 }).tracks.V1.items[0]).toMatchObject({ zoom: 1.2, tilt: 30 });
  });
});
