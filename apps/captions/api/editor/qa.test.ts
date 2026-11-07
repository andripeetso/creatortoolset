import { describe, expect, it } from "vitest";
import type { Item, Timeline } from "../../contracts/editor";
import { qaOf, sharedVoice } from "./qa";
import { emptyTracks } from "./timeline";

/** A 30 fps timeline of linked speaker shots [src, in, len], laid end to end from `rec` 0 unless given. */
function tl(shots: [string, number, number, number?][]): Timeline {
  const t: Timeline = {
    name: "t",
    fps: 30,
    width: 1080,
    height: 1920,
    sources: { A: { versionId: "A", name: "Take A", fps: 30, tc: 0, dur: 9000, w: 1080, h: 1920 }, B: { versionId: "B", name: "Take B", fps: 60, tc: 0, dur: 9000, w: 1080, h: 1920 } },
    tracks: emptyTracks(),
    markers: [],
  };
  let rec = 0;
  shots.forEach(([src, inF, len, at], k) => {
    rec = at ?? rec;
    const i: Item = { src, in: inF, len, rec, link: `c${k}` };
    t.tracks.V1.items.push(i);
    t.tracks.A1.items.push({ ...i });
    rec += len;
  });
  return t;
}

describe("AI Editor QA", () => {
  it("finds a gap and a speaker shot under 13 frames", () => {
    const r = qaOf(tl([["A", 0, 40], ["A", 100, 12, 50]]));
    expect(r.ok).toBe(false);
    expect(r.notes).toEqual([
      "V1: a gap of 10 frames at 40",
      "A1: a gap of 10 frames at 40",
      "V1: a 12-frame speaker shot at 50 (under 13)",
    ]);
    expect(qaOf(tl([["A", 0, 40], ["A", 100, 13]]))).toEqual({ ok: true, notes: [], shared: [] });
  });

  it("measures the voice two versions share exactly, in each source's own frames", () => {
    // v1: A 0-100 and A 100-150 (one run of 150 source frames), B 0-60 (30 timeline frames at 60 fps = 60 source frames)
    const v1 = tl([["A", 0, 100], ["A", 100, 50], ["B", 0, 30]]);
    // v2: A 50-250 and B 30-90
    const v2 = tl([["A", 50, 200], ["B", 30, 30]]);
    const s = sharedVoice(v1, v2);
    // shared: A 50-150 (100 frames) + B 30-60 (30 frames) of v1's 150 + 60 = 210 voice frames
    expect(s.pct).toBeCloseTo((130 / 210) * 100, 10);
    expect(s.longestS).toBeCloseTo(100 / 30, 10);
    const r = qaOf(v1, { v2 });
    expect(r.shared).toEqual([{ with: "v2", pct: 61.9, longestS: 3.33 }]);
    expect(r.notes).toEqual(["Shares 61.9 % of its voice with v2 (over 20 %)"]);
    expect(sharedVoice(v1, tl([["A", 500, 100]])).pct).toBe(0);
  });

  it("notes sound running on past the picture", () => {
    const t = tl([["A", 0, 40]]);
    t.tracks.A2.items.push({ src: "A", in: 0, len: 50, rec: 0 });
    expect(qaOf(t).notes).toEqual(["The last 10 frames have sound over black"]);
  });
});
