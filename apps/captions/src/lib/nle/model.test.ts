import { describe, expect, it } from "vitest";
import {
  addSource, addTrack, blade, clipsFrom, copyOf, duplicate, endOf, extendTo, find, freeTrack, lengthOf, move, rippleToPlayhead, paste, place, remove, removeTrack, roll,
  setItems, setSpeed, setTrack, slip, timecode, toSaved, trim, unlink, withKeys, type NleTimeline,
} from "./model";

// A reel: two talking shots on V1 with their voice on A1 (linked), a B-roll clip on V2 and a song on A2.
const reel = (): NleTimeline =>
  withKeys({
    edj_version: 1,
    timeline: { fps: 25, width: 1080, height: 1920, duration: 150, name: "Tiny Acrobatics reel", start: 90000 },
    sources: { cam: { path: "/m/cam.mp4", fps: 25, dur: 1000 }, b: { path: "/m/roll.mp4", fps: 50, dur: 400 }, song: { path: "/m/song.m4a", fps: 25 } },
    tracks: {
      V1: { name: "TALENT", items: [{ src: "cam", rec: 0, len: 75, in: 100, link: 1, line: "L01", why: "the hook" }, { src: "cam", rec: 75, len: 75, in: 400, link: 2 }] },
      A1: { name: "VO", items: [{ src: "cam", rec: 0, len: 75, in: 100, link: 1 }, { src: "cam", rec: 75, len: 75, in: 400, link: 2 }] },
      V2: { name: "B-ROLL", items: [{ src: "b", rec: 90, len: 40, in: 0 }] },
      A2: { name: "MUSIC", items: [{ src: "song", rec: 0, len: 150, in: 0, gain_db: -7.5 }] },
    },
    markers: [{ frame: 0, name: "L01" }],
  });

const key = (tl: NleTimeline, track: string, rec: number) => tl.tracks[track].items.find((i) => i.rec === rec)!._k!;
const spans = (tl: NleTimeline, track: string) => tl.tracks[track].items.map((i) => [i.rec, i.len, i.in]);

describe("nle model", () => {
  it("keeps fields it does not know and takes its handles off on save", () => {
    const tl = reel();
    const saved = toSaved(setItems(tl, [key(tl, "V1", 0)], { zoom: 1.2 }));
    expect(saved.edj_version).toBe(1);
    expect(saved.markers).toEqual([{ frame: 0, name: "L01" }]);
    expect(saved.timeline.start).toBe(90000);
    expect(saved.tracks.V1.items[0]).toEqual({ src: "cam", rec: 0, len: 75, in: 100, link: 1, line: "L01", why: "the hook", zoom: 1.2 });
    expect(JSON.stringify(saved)).not.toContain("_k");
  });

  it("writes a timecode, with hours from an hour", () => {
    expect(timecode(59, 30)).toBe("0:01:29");
    expect(timecode(30 * 3725 + 3, 30)).toBe("1:02:05:03");
  });

  it("moves a clip hours out and back: there is no end", () => {
    const tl = reel();
    const k = key(tl, "V2", 90);
    const out = move(tl, [k], 30 * 3600 * 10);
    expect(lengthOf(out)).toBe(endOf(find(out, k)!.item));
    expect(lengthOf(out)).toBeGreaterThan(30 * 3600 * 10);
    expect(lengthOf(move(out, [k], -30 * 3600 * 10))).toBe(150);
  });

  it("is as long as the last clip on any track, past the talent too", () => {
    let tl = reel();
    expect(lengthOf(tl)).toBe(150);
    tl = trim(tl, key(tl, "A2", 0), "tail", 40);
    expect(lengthOf(tl)).toBe(190);
    expect(toSaved(tl).timeline.duration).toBe(190);
    expect(lengthOf(setTrack(tl, "A2", { enabled: false }))).toBe(150);
    // a muted or hidden track plays nothing, so it makes nothing longer (as the render)
    expect(lengthOf(setTrack(tl, "A2", { mute: true }))).toBe(150);
  });

  it("moves linked clips together and overwrites what they land on", () => {
    const tl = reel();
    const out = move(tl, [key(tl, "V1", 75)], 20);
    expect(spans(out, "V1")).toEqual([[0, 75, 100], [95, 75, 400]]);
    expect(spans(out, "A1")).toEqual([[0, 75, 100], [95, 75, 400]]);
    // back over the first shot: it is cut back to where the moved one starts
    const back = move(tl, [key(tl, "V1", 75)], -30);
    expect(spans(back, "V1")).toEqual([[0, 45, 100], [45, 75, 400]]);
    expect(spans(back, "A1")).toEqual([[0, 45, 100], [45, 75, 400]]);
    // never before 0
    expect(spans(move(tl, [key(tl, "V2", 90)], -500), "V2")).toEqual([[0, 40, 0]]);
  });

  it("moves a clip onto another track of its kind, and splits what it lands in the middle of", () => {
    const tl = reel();
    const out = move(tl, [key(tl, "V2", 90)], -60, { from: "V2", to: "V1" });
    expect(out.tracks.V2.items).toEqual([]);
    expect(spans(out, "V1")).toEqual([[0, 30, 100], [30, 40, 0], [70, 5, 170], [75, 75, 400]]);
    // a picture never goes onto a sound track
    expect(spans(move(tl, [key(tl, "V2", 90)], 0, { from: "V2", to: "A2" }), "V2")).toEqual([[90, 40, 0]]);
  });

  it("trims inside the source and up to the neighbour; ripple pushes the rest", () => {
    const tl = reel();
    const first = key(tl, "V1", 0);
    // a plain trim of the first shot's tail stops at the second shot
    expect(spans(trim(tl, first, "tail", 30), "V1")).toEqual([[0, 75, 100], [75, 75, 400]]);
    // head pulled back: as far as the source goes (100 frames before), never before 0
    expect(spans(trim(tl, first, "head", -50), "V1")).toEqual([[0, 75, 100], [75, 75, 400]]);
    const second = key(tl, "V1", 75);
    expect(spans(trim(tl, second, "head", 10), "V1")).toEqual([[0, 75, 100], [85, 65, 410]]);
    expect(spans(trim(tl, second, "head", 10), "A1")).toEqual([[0, 75, 100], [85, 65, 410]]);
    // ripple: the first shot 25 frames longer, everything after it later by 25, on every track
    const r = trim(tl, first, "tail", 25, true);
    expect(spans(r, "V1")).toEqual([[0, 100, 100], [100, 75, 400]]);
    expect(spans(r, "A1")).toEqual([[0, 100, 100], [100, 75, 400]]);
    expect(spans(r, "V2")).toEqual([[115, 40, 0]]);
    expect(spans(r, "A2")).toEqual([[0, 150, 0]]);
    // ripple head trim: the start stays, the clip begins later in its source, the rest comes up
    const h = trim(tl, second, "head", 10, true);
    expect(spans(h, "V1")).toEqual([[0, 75, 100], [75, 65, 410]]);
  });

  it("stops a trim at the end of the source, counted in the source's own frames", () => {
    const tl = reel();
    // B-roll at 50 fps on a 25 fps timeline: 400 source frames = 200 timeline frames, 40 used
    const out = trim(tl, key(tl, "V2", 90), "tail", 1000);
    expect(spans(out, "V2")).toEqual([[90, 200, 0]]);
    // a source with no length is not stopped
    expect(spans(trim(tl, key(tl, "A2", 0), "tail", 5000), "A2")).toEqual([[0, 5150, 0]]);
    // never shorter than a frame
    expect(spans(trim(tl, key(tl, "V2", 90), "tail", -500), "V2")).toEqual([[90, 1, 0]]);
  });

  it("rolls the cut between two shots", () => {
    const tl = reel();
    const out = roll(tl, key(tl, "V1", 0), 10);
    expect(spans(out, "V1")).toEqual([[0, 85, 100], [85, 65, 410]]);
    expect(spans(out, "A1")).toEqual([[0, 85, 100], [85, 65, 410]]);
    expect(lengthOf(out)).toBe(150);
  });

  it("slips what a clip shows, with its voice", () => {
    const tl = reel();
    const out = slip(tl, key(tl, "V1", 0), 20);
    expect(spans(out, "V1")[0]).toEqual([0, 75, 120]);
    expect(spans(out, "A1")[0]).toEqual([0, 75, 120]);
    expect(spans(slip(tl, key(tl, "V1", 0), -500), "V1")[0]).toEqual([0, 75, 0]);
  });

  it("blades every unlocked track at a frame, or only the picked clips", () => {
    const tl = setTrack(reel(), "A2", { locked: true });
    const out = blade(tl, 30);
    expect(spans(out, "V1")).toEqual([[0, 30, 100], [30, 45, 130], [75, 75, 400]]);
    expect(spans(out, "A2")).toEqual([[0, 150, 0]]);
    // the right half keeps the fields it doesn't know
    expect(out.tracks.V1.items[1].line).toBe("L01");
    const one = blade(tl, 100, [key(tl, "V2", 90)]);
    expect(spans(one, "V2")).toEqual([[90, 10, 0], [100, 30, 20]]);
    expect(spans(one, "V1")).toEqual(spans(tl, "V1"));
  });

  it("deletes and ripple-deletes, every track kept in sync", () => {
    const tl = reel();
    const k = key(tl, "V1", 0);
    expect(spans(remove(tl, [k]), "V1")).toEqual([[75, 75, 400]]);
    expect(spans(remove(tl, [k]), "A1")).toEqual([[75, 75, 400]]);
    // the song runs under the gap and on: it stays, what comes after the gap moves up
    const r0 = remove(tl, [k], true);
    expect(spans(r0, "V1")).toEqual([[0, 75, 400]]);
    expect(spans(r0, "A2")).toEqual([[0, 150, 0]]);
    // a clip in the way on another track stops it there, so nothing runs into anything
    const blocked = place(tl, [{ track: "V2", item: { src: "b", rec: 60, len: 5, in: 0 } }]).tl;
    expect(spans(remove(blocked, [key(blocked, "V1", 0)], true), "V1")).toEqual([[65, 75, 400]]);
    const noSong = remove(tl, [key(tl, "A2", 0)]);
    const r = remove(noSong, [key(noSong, "V1", 0)], true);
    expect(spans(r, "V1")).toEqual([[0, 75, 400]]);
    expect(spans(r, "V2")).toEqual([[15, 40, 0]]);
    expect(lengthOf(r)).toBe(75);
  });

  it("lays clips by overwrite or insert", () => {
    const tl = reel();
    const clip = { src: "b", rec: 30, len: 20, in: 0 };
    const o = place(tl, [{ track: "V1", item: clip }]);
    expect(spans(o.tl, "V1")).toEqual([[0, 30, 100], [30, 20, 0], [50, 25, 150], [75, 75, 400]]);
    expect(find(o.tl, o.keys[0])?.track).toBe("V1");
    const ins = place(tl, [{ track: "V1", item: clip }], "insert");
    expect(spans(ins.tl, "V1")).toEqual([[0, 30, 100], [30, 20, 0], [50, 45, 130], [95, 75, 400]]);
    expect(spans(ins.tl, "A2")).toEqual([[0, 30, 0], [50, 120, 30]]);
    expect(lengthOf(ins.tl)).toBe(170);
  });

  it("copies, pastes and duplicates with a link of their own", () => {
    const tl = reel();
    const d = duplicate(tl, [key(tl, "V1", 75)]);
    expect(spans(d.tl, "V1")).toEqual([[0, 75, 100], [75, 75, 400], [150, 75, 400]]);
    expect(spans(d.tl, "A1").at(-1)).toEqual([150, 75, 400]);
    const copies = d.keys.map((k) => find(d.tl, k)!.item);
    expect(copies[0].link).toBe(copies[1].link);
    expect(copies[0].link).not.toBe(2);
    const p = paste(tl, copyOf(tl, [key(tl, "V2", 90)]), 10);
    expect(spans(p.tl, "V2")).toEqual([[10, 40, 0], [90, 40, 0]]);
  });

  it("unlinks, so a shot moves without its voice", () => {
    const base = reel();
    const tl = unlink(base, [key(base, "V1", 0)]);
    const k = key(tl, "V1", 0);
    expect(find(tl, k)!.item.link).toBeUndefined();
    const out = move(tl, [k], 5);
    expect(spans(out, "A1")[0]).toEqual([0, 75, 100]);
  });

  it("leaves locked tracks alone", () => {
    const tl = setTrack(reel(), "V2", { locked: true });
    expect(move(tl, [key(tl, "V2", 90)], 10)).toBe(tl);
    expect(setItems(tl, [key(tl, "V2", 90)], { zoom: 2 })).toBe(tl);
    expect(removeTrack(tl, "V2")).toBe(tl);
  });

  it("adds and removes tracks, finds a free one, and names a source once", () => {
    const tl = reel();
    const v3 = addTrack(tl, "V");
    expect(v3.id).toBe("V3");
    expect(removeTrack(v3.tl, "V3").tracks.V3).toBeUndefined();
    expect(removeTrack(tl, "V1")).toBe(tl);
    expect(freeTrack(tl, "A", 0, 10, 2).id).toBe("A3");
    expect(freeTrack(tl, "V", 0, 10, 2).id).toBe("V2");
    const s = addSource(tl, { path: "/m/new/cam.mp4", fps: 25 });
    expect(s.src).toBe("cam.mp4");
    expect(addSource(s.tl, { path: "/m/cam.mp4" }).src).toBe("cam");
    expect(addSource(s.tl, { path: "/x/cam.mp4" }).src).toBe("cam.mp4+");
  });

  it("sets and clears clip fields", () => {
    const tl = reel();
    const k = key(tl, "V2", 90);
    const out = setItems(tl, [k], { rot: 15, flip: "h", crop: [0.1, 0, 0, 0.2], opacity: 0.5 });
    expect(find(out, k)!.item).toMatchObject({ rot: 15, flip: "h", crop: [0.1, 0, 0, 0.2], opacity: 0.5 });
    expect(find(setItems(out, [k], { flip: undefined }), k)!.item.flip).toBeUndefined();
    // twice as fast: the B-roll's 200 timeline frames of source last 100, so a 40-frame clip stays 40; ×8 ends at 25
    expect(find(setSpeed(tl, [k], 2), k)!.item).toMatchObject({ speed: 2, len: 40 });
    expect(find(setSpeed(tl, [k], 8), k)!.item).toMatchObject({ speed: 8, len: 25 });
    expect(find(setSpeed(setSpeed(tl, [k], 2), [k], 1), k)!.item.speed).toBeUndefined();
  });
});

describe("nle keys", () => {
  it("Y picks the clips from the playhead on, ⌥Y on one track, ⌘Y the ones before", () => {
    const tl = reel();
    expect(clipsFrom(tl, 80, 1).length).toBe(4); // V1 + A1 second shots, the B-roll, the song under the playhead
    expect(clipsFrom(tl, 80, 1, ["V1"])).toEqual([key(tl, "V1", 75)]);
    expect(clipsFrom(tl, 80, -1, ["V1", "V2"])).toEqual([key(tl, "V1", 0), key(tl, "V1", 75)]);
  });

  it("Q and W ripple the V1 clip under the playhead to it, what follows moves up", () => {
    const tl = reel();
    const q = rippleToPlayhead(tl, 85, "head", []);
    expect(spans(q, "V1")).toEqual([[0, 75, 100], [75, 65, 410]]);
    expect(spans(q, "A1")).toEqual([[0, 75, 100], [75, 65, 410]]);
    expect(spans(q, "V2")).toEqual([[80, 40, 0]]);
    const w = rippleToPlayhead(tl, 60, "tail", []);
    expect(spans(w, "V1")).toEqual([[0, 60, 100], [60, 75, 400]]);
    expect(rippleToPlayhead(tl, 200, "head", [])).toBe(tl);
  });

  it("E rolls a cut to the playhead, or trims a free end", () => {
    const tl = reel();
    expect(spans(extendTo(tl, key(tl, "V1", 0), 70), "V1")).toEqual([[0, 70, 100], [70, 80, 395]]);
    expect(spans(extendTo(tl, key(tl, "V2", 90), 120), "V2")).toEqual([[90, 30, 0]]);
    expect(spans(extendTo(tl, key(tl, "V2", 90), 140), "V2")).toEqual([[90, 50, 0]]);
  });
});
