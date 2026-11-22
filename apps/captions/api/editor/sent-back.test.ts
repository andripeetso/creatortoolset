import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { importTimeline, timelineSources } from "../../contracts/timeline-import";
import { toEdl } from "./edl";
import { toFcp7Xml, toFcpxml } from "./fcpxml";
import { otioText, toOtio } from "./otio";
import { introLength, withIntro } from "./intro";
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
const files: Record<string, string> = { ver_a: "/Users/tiny/Footage/Take A.mov", ver_b: "/Users/tiny/Footage/Take B.mov", ver_c: "/Users/tiny/Footage/Crash mat.mov", ver_i: "/Users/tiny/Footage/Their video.mov" };
const writers = {
  "Tiny.otio": (tl: Timeline) => otioText(toOtio(tl, files)),
  "Tiny.fcpxml": (tl: Timeline) => toFcpxml(tl, files),
  "Tiny.xml": (tl: Timeline) => toFcp7Xml(tl, files),
  "Tiny.edl": (tl: Timeline) => toEdl(tl, files),
};
const back = (name: string, text: string, tl = draft(), f: Record<string, string> = files) => fromSentBack(tl, f, importTimeline(name, text, tl.fps), timelineSources(name, text, tl.fps), formatOf(text));
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

  for (const [name, write] of Object.entries(writers)) {
    it(`${name}: an intro sent back is still the intro, so B-roll later stays off it`, () => {
      const src = { versionId: "ver_i", name: "Their video", fps: 29.97, tc: 0, dur: 900, w: 1920, h: 1080 };
      const tl = withIntro(draft(), { source: "ver_i" }, { a: 1, b: 3, text: "" }, src);
      const back1 = back(name, write(tl), tl);
      expect(introLength(back1)).toBe(introLength(tl));
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

  it("a voice recording gets its shot back, linked; a track keeps its own clips when the one before it is empty; pieces keep their own window", () => {
    const tl = draft();
    tl.sources.ver_v = { versionId: "ver_v", name: "Voice memo", fps: 29.97, tc: 0, dur: 600, w: 0, h: 0 };
    files.ver_v = "/Users/tiny/Footage/Voice memo.m4a";
    tl.tracks.V1.items.push({ src: "ver_v", in: 0, len: 30, rec: 105, link: "c3" });
    tl.tracks.A1.items.push({ src: "ver_v", in: 0, len: 30, rec: 105, link: "c3" });
    // a whoosh on A3 with no music on A2
    tl.tracks.A3.items = [{ src: "ver_c", in: 0, len: 10, rec: 40, gainDb: -6 }];
    // the first shot reframed, its window moving right over its 45 frames
    tl.tracks.V1.items[0]!.path = [{ t: 0, x: 0.2 }, { t: 1.5, x: 0.8 }];
    const changed = JSON.parse(JSON.stringify(tl)) as Timeline;
    // in the app: the first take's voice cut 15 frames in, so its shot is cut in two there
    changed.tracks.A1.items[0] = { ...changed.tracks.A1.items[0]!, len: 15 };
    changed.tracks.A1.items.splice(1, 0, { src: "ver_a", in: 27, len: 30, rec: 15 });
    const back1 = fromSentBack(tl, files, importTimeline("a.otio", writers["Tiny.otio"](changed)), timelineSources("a.otio", writers["Tiny.otio"](changed)), "otio");
    const memo = back1.tracks.V1.items.find((i) => i.src === "ver_v")!;
    expect(memo).toMatchObject({ rec: 105, len: 30, in: 0 });
    expect(back1.tracks.A1.items.find((a) => a.src === "ver_v")!.link).toBe(memo.link);
    expect(back1.tracks.A2.items).toEqual([]);
    expect(back1.tracks.A3.items).toEqual([{ src: "ver_c", in: 0, len: 10, rec: 40, gainDb: -6 }]);
    // the second piece starts where the window had got to, not back at the left
    const [p1, p2] = back1.tracks.V1.items.filter((i) => i.src === "ver_a");
    expect(p1!.path![0]!.x).toBe(0.2);
    expect(p2!.path![0]!.x).toBeGreaterThan(0.3);
    expect(p2!.path!.at(-1)!.x).toBe(0.8);
    delete files.ver_v;
  });

  it("an EDL's source in is from the file's first frame (its timecode taken off); the draft's markers stay", () => {
    const edl = [
      "TITLE: Tiny",
      // the camera's own drop-frame timecode, the record side counted from the hour
      "001  TAKEA    V     C        01:00:00;12 01:00:01;27 01:00:00:00 01:00:01:15",
      "* SOURCE FILE: /Users/tiny/Footage/Take A.mov",
    ].join("\n");
    const tl = back("Tiny.edl", edl);
    expect(tl.tracks.V1.items.map((i) => [i.src, i.in, i.rec, i.len])).toEqual([["ver_a", 12, 0, 45]]);
    expect(tl.tracks.A1.items.map((i) => [i.src, i.in, i.rec, i.len])).toEqual([["ver_a", 12, 0, 45]]);
    expect(tl.markers).toEqual(draft().markers);
  });

  it("a planned edit's next round stays in the app", () => {
    expect(() => back("Tiny.otio", writers["Tiny.otio"](draft()), { ...draft(), plan: { song: null } as unknown as Timeline["plan"] })).toThrow(/planned edit/);
  });
});
