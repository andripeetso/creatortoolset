import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { importTimeline, timelineSources } from "../../contracts/timeline-import";
import { toFcp7Xml, toFcpxml } from "./fcpxml";
import { otioText, toOtio } from "./otio";
import { formatOf, fromSentBack, SentBackRefused, sentBackSummary } from "./sent-back";
import { emptyTracks, sourceOf } from "./timeline";

/** Two takes at 29.97 fps, one at 59.94 with a drop-frame start timecode on the other, punched in on the second shot. */
function draft(): Timeline {
  const probe = { duration: 20, width: 1080, height: 1920, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
  const tl: Timeline = {
    name: "Tiny Acrobatics v1",
    fps: 29.97,
    width: 1080,
    height: 1920,
    sources: {
      ver_a: sourceOf("ver_a", "Take A", { ...probe, fps: 29.97, timecode: "01:00:00;00" }),
      ver_b: sourceOf("ver_b", "Take B", { ...probe, fps: 59.94 }),
      ver_c: sourceOf("ver_c", "Crash mat", { ...probe, fps: 29.97 }),
    },
    tracks: emptyTracks(),
    markers: [
      { rec: 0, name: "L1", color: "BLUE", note: "We teach rolls" },
      { rec: 45, name: "L2", color: "BLUE", note: "Join the class" },
    ],
  };
  tl.tracks.V1.items = [
    { src: "ver_a", in: 12, len: 45, rec: 0, link: "c1" },
    { src: "ver_b", in: 300, len: 60, rec: 45, link: "c2", zoom: 1.15, tilt: -34.56 },
  ];
  tl.tracks.A1.items = tl.tracks.V1.items.map(({ zoom: _z, tilt: _t, ...i }) => i);
  tl.tracks.V2.items = [{ src: "ver_c", in: 30, len: 20, rec: 50, zoom: 1.2 }];
  return tl;
}
const files = { ver_a: "/Users/tiny/Footage/Take A.mov", ver_b: "/Users/tiny/Footage/Take B.mov", ver_c: "/Users/tiny/Footage/Crash mat.mov" };
const writers = {
  "Tiny.otio": (tl: Timeline) => otioText(toOtio(tl, files)),
  "Tiny.fcpxml": (tl: Timeline) => toFcpxml(tl, files),
  "Tiny.xml": (tl: Timeline) => toFcp7Xml(tl, files),
};
const back = (name: string, text: string, tl = draft(), f: Record<string, string> = files) => fromSentBack(tl, f, importTimeline(name, text), timelineSources(name, text), formatOf(text));
/** The parts the files carry and the draft keeps, links by pairing (their names are renumbered). */
const shape = (tl: Timeline) => ({
  V1: tl.tracks.V1.items.map(({ link, ...i }) => ({ ...i, linked: !!link })),
  A1: tl.tracks.A1.items.map(({ link, ...i }) => ({ ...i, linked: !!link })),
  V2: tl.tracks.V2.items,
  markers: tl.markers,
  sources: Object.keys(tl.sources).sort(),
});

describe("next round from a timeline sent back", () => {
  for (const [name, write] of Object.entries(writers)) {
    it(`${name}: a draft sent back unchanged reads back as the same draft`, () => {
      expect(shape(back(name, write(draft())))).toEqual(shape(draft()));
    });
  }

  it("the editing app's changes are the truth; framing the file can't carry comes from the clip it was cut from", () => {
    // in the app: the first shot trimmed 10 frames at its head, the second cut in two with a J cut, the B-roll moved
    const changed = draft();
    changed.tracks.V1.items = [
      { src: "ver_a", in: 22, len: 35, rec: 0 },
      { src: "ver_b", in: 300, len: 30, rec: 35 },
      { src: "ver_b", in: 380, len: 20, rec: 65 },
    ];
    changed.tracks.A1.items = [
      { src: "ver_a", in: 22, len: 40, rec: 0 },
      { src: "ver_b", in: 310, len: 25, rec: 40 },
      { src: "ver_b", in: 380, len: 20, rec: 65 },
    ];
    changed.tracks.V2.items = [{ src: "ver_c", in: 30, len: 20, rec: 10 }];
    const tl = back("Tiny.otio", writers["Tiny.otio"](changed));
    // the shot is cut where the voice changes, each piece linked to the voice under it, from the same frame
    expect(tl.tracks.V1.items.map((i) => [i.src, i.in, i.rec, i.len, !!i.link, i.zoom ?? 1])).toEqual([
      ["ver_a", 22, 0, 35, true, 1],
      ["ver_b", 300, 35, 5, true, 1.15], // an L cut: the next picture over the first take's last words
      ["ver_b", 310, 40, 25, true, 1.15],
      ["ver_b", 380, 65, 20, true, 1.15],
    ]);
    expect(tl.tracks.A1.items.map((i) => [i.src, i.in, i.rec, i.len])).toEqual([
      ["ver_a", 22, 0, 35],
      ["ver_a", 57, 35, 5],
      ["ver_b", 310, 40, 25],
      ["ver_b", 380, 65, 20],
    ]);
    for (const v of tl.tracks.V1.items.filter((i) => i.link)) {
      const a = tl.tracks.A1.items.find((x) => x.link === v.link)!;
      expect([a.rec, a.len]).toEqual([v.rec, v.len]);
    }
    expect(tl.tracks.V2.items).toEqual([{ src: "ver_c", in: 30, len: 20, rec: 10, zoom: 1.2 }]);
    expect(sentBackSummary(draft(), tl)).toBe("3 → 5 clips, 3.5 → 2.8 s");
  });

  it("matches the files by name when the app relinked them elsewhere", () => {
    const moved = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, p.replace("/Users/tiny/Footage", "/Volumes/Edit/Tiny")]));
    const text = toFcp7Xml(draft(), moved);
    expect(shape(back("Tiny.xml", text))).toEqual(shape(draft()));
  });

  it("refuses a clip that isn't the draft's footage, another frame rate, and a third picture track, saying what to do", () => {
    const other = otioText(toOtio(draft(), { ...files, ver_c: "/Users/tiny/Footage/Holiday.mov" }));
    expect(() => back("Tiny.otio", other)).toThrow(/Not footage of this draft: Holiday\.mov/);
    const fast = { ...draft(), fps: 25 };
    expect(() => back("Tiny.otio", writers["Tiny.otio"](draft()), fast)).toThrow(SentBackRefused);
    expect(() => back("Tiny.otio", writers["Tiny.otio"](draft()), fast)).toThrow(/29\.97 fps and the draft at 25/);
    const otio = JSON.parse(writers["Tiny.otio"](draft()));
    const v2 = otio.tracks.children.find((t: { name: string }) => t.name === draft().tracks.V2.name);
    otio.tracks.children.splice(2, 0, JSON.parse(JSON.stringify(v2)));
    expect(() => back("Tiny.otio", JSON.stringify(otio))).toThrow(/clips on V3/);
  });

  it("a track the format never carried keeps the draft's clips (FCPXML: the shots with their own sound)", () => {
    const changed = draft();
    changed.tracks.V1.items = [{ src: "ver_b", in: 300, len: 60, rec: 0, link: "c2" }];
    const tl = back("Tiny.fcpxml", writers["Tiny.fcpxml"](changed));
    expect(tl.tracks.V1.items.map((i) => [i.src, i.in, i.rec, i.len, i.zoom])).toEqual([["ver_b", 300, 0, 60, 1.15]]);
    expect(tl.tracks.A1.items.map((i) => [i.src, i.in, i.rec, i.len, i.link])).toEqual([["ver_b", 300, 0, 60, tl.tracks.V1.items[0]!.link]]);
    expect(tl.tracks.V2.items).toEqual(draft().tracks.V2.items);
  });

  it("a planned edit's next round stays in the app", () => {
    expect(() => back("Tiny.otio", writers["Tiny.otio"](draft()), { ...draft(), plan: { song: null } as unknown as Timeline["plan"] })).toThrow(/planned edit/);
  });
});
