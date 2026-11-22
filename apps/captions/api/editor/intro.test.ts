import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { afterIntro, introAgain, introLength, introParts, pipPlace, PIP_SIZE, secondsOf, withIntro } from "./intro";
import { emptyTracks } from "./timeline";

const sents = [
  { s: 0, e: 4, text: "One." },
  { s: 4.5, e: 9, text: "Two." },
  { s: 9.2, e: 14, text: "Three." },
  { s: 14.5, e: 30, text: "Four." },
  { s: 31, e: 33, text: "Five." },
];

describe("AI Editor intro", () => {
  it("gives each version its own whole sentences, the end nearest its length, none shared, null when none are left", () => {
    expect(introParts(sents, [12, 3, 20, 5])).toEqual([
      { a: 0, b: 14, text: "One. Two. Three." }, // 14 s is nearer 12 than 9 s
      { a: 14.5, b: 30, text: "Four." },
      { a: 31, b: 33, text: "Five." },
      null,
    ]);
    // the same inputs, the same parts: a version cut again opens on its own words
    expect(introParts(sents, [12, 3])).toEqual(introParts(sents, [12, 3]));
    expect(introParts(secondsOf(10.6), [3, 3, 3, 3])).toEqual([
      { a: 0, b: 3, text: "" }, { a: 3, b: 6, text: "" }, { a: 6, b: 9, text: "" }, { a: 9, b: 10, text: "" },
    ]);
  });

  it("puts the reaction in its corner, 50 px in on a UHD frame", () => {
    // a vertical reaction on a 2160x3840 timeline: its picture is 648x1152 at 0.3
    expect(pipPlace("bottom-left", { w: 1080, h: 1920 }, 2160, 3840)).toEqual({ pan: -706, tilt: -1294 });
    expect(pipPlace("top-right", { w: 1080, h: 1920 }, 2160, 3840)).toEqual({ pan: 706, tilt: 1294 });
    // a widescreen reaction is fitted to the width first: 1080x607.5 on a 1080x1920 frame, 324x182.25 at 0.3
    expect(pipPlace("bottom-right", { w: 1920, h: 1080 }, 1080, 1920)).toEqual({ pan: 353, tilt: -843.9 });
  });

  it("plays the intro with its sound first and moves the cut after it; the reaction ends with the intro, silent", () => {
    const tl: Timeline = {
      name: "Tiny Acrobatics v1", fps: 25, width: 1080, height: 1920,
      sources: { ver_a: { versionId: "ver_a", name: "Take A", fps: 25, tc: 0, dur: 500, w: 1080, h: 1920 } },
      tracks: emptyTracks(),
      markers: [{ rec: 0, name: "L1", color: "BLUE", note: "We teach rolls" }],
      speakers: [{ rec: 0, len: 50, speaker: 1 }],
    };
    tl.tracks.V1.items = [{ src: "ver_a", in: 10, len: 50, rec: 0, link: "c1", zoom: 1.2 }];
    tl.tracks.A1.items = [{ src: "ver_a", in: 10, len: 50, rec: 0, link: "c1" }];
    const intro = { versionId: "ver_i", name: "Their video", fps: 50, tc: 0, dur: 3000, w: 1920, h: 1080 };
    const react = { versionId: "ver_r", name: "Reaction", fps: 25, tc: 0, dur: 100, w: 1080, h: 1920 };
    const out = withIntro(tl, { source: "ver_i", reaction: "ver_r" }, { a: 2, b: 8, text: "Watch this." }, intro, react);
    expect(out.tracks.V1.items).toEqual([
      { src: "ver_i", in: 100, len: 150, rec: 0, link: "intro" },
      { src: "ver_a", in: 10, len: 50, rec: 150, link: "c1", zoom: 1.2 },
    ]);
    expect(out.tracks.A1.items.map((i) => [i.src, i.rec, i.len])).toEqual([["ver_i", 0, 150], ["ver_a", 150, 50]]);
    // the reaction's last 4 s (all it has) over the intro's last 4 s
    expect(out.tracks.V2.items).toEqual([{ src: "ver_r", in: 0, len: 100, rec: 50, zoom: PIP_SIZE, pan: -353, tilt: -647 }]);
    expect(out.markers.map((m) => [m.rec, m.name])).toEqual([[0, "Intro"], [150, "L1"]]);
    expect(out.speakers).toEqual([{ rec: 150, len: 50, speaker: 1 }]);
    expect(Object.keys(out.sources).sort()).toEqual(["ver_a", "ver_i", "ver_r"]);
    expect(tl.tracks.V1.items).toHaveLength(1); // the cut given is left as it was
    // no reaction: the intro alone
    expect(withIntro(tl, { source: "ver_i" }, { a: 2, b: 8, text: "" }, intro).tracks.V2.items).toEqual([]);

    // B-roll is laid on the person's own cut (afterIntro) and the intro with its reaction goes back before it (introAgain)
    expect(introLength(out)).toBe(150);
    const own = afterIntro(out);
    expect(own.tracks.V1.items).toEqual(tl.tracks.V1.items);
    expect(own.markers).toEqual(tl.markers);
    expect(own.tracks.V2.items).toEqual([]);
    const laid = { ...own, tracks: { ...own.tracks, V2: { ...own.tracks.V2, items: [{ src: "ver_b", in: 0, len: 20, rec: 10 }] } } };
    const back = introAgain(out, laid);
    expect(back.tracks.V2.items.map((i) => [i.src, i.rec])).toEqual([["ver_r", 50], ["ver_b", 160]]);
    expect(back.tracks.V1.items).toEqual(out.tracks.V1.items);
    expect(back.markers).toEqual(out.markers);
    expect(afterIntro(tl)).toBe(tl); // no intro: as it is
  });
});
