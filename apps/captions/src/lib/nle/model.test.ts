import { describe, expect, it } from "vitest";
import {
  addSource, addTrack, isPlain, partsOf, putParts, resetFields, setFades, blade, clipsFrom, copyOf, duplicate, endOf, extendTo, find, freeTrack, lengthOf, move, rippleToPlayhead, paste, place, remove, deleteTrack, roll,
  fadeAt, setFade, setItems, setSpeed, setTrack, slip, timecode, toSaved, trim, unlink, withKeys, type NleTimeline,
  NO_MARKS, clipOfPart, editTracks, loopNext, loopPart, markedPart, setMark, sourceTimeline, type Marks,
  closeGap, extract, lift, rateStretch, slide, type NleItem, processingOf, setClipProcessing, setTimelineProcessing, addMarker, markerAt, markersCsv, removeMarker, setMarker,
} from "./model";
import { valueAt } from "./keyframes";

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
    expect(deleteTrack(tl, "V2")).toBe(tl);
  });

  it("adds and removes tracks, finds a free one, and names a source once", () => {
    const tl = reel();
    const v3 = addTrack(tl, "V");
    expect(v3.id).toBe("V3");
    expect(deleteTrack(v3.tl, "V3").tracks.V3).toBeUndefined();
    expect(deleteTrack(tl, "V1")).toBe(tl);
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

  it("fades: whole frames, never longer than the clip less its other fade, 0 takes it off", () => {
    const tl = reel();
    const k = key(tl, "V1", 0);
    const a = setFades(tl, [k], "in", 12.4);
    expect(find(a, k)!.item.fade_in).toBe(12);
    const b = setFades(a, [k], "out", 500);
    expect(find(b, k)!.item.fade_out).toBe(63);
    expect(find(setFades(b, [k], "in", 0), k)!.item.fade_in).toBeUndefined();
  });

  it("a section turned off and on again gets its values back, speed included", () => {
    const tl = reel();
    const k = key(tl, "V2", 90);
    const fields = ["zoom", "rot", "speed"];
    const set = setSpeed(setItems(tl, [k], { zoom: 1.5, rot: 10 }), [k], 2);
    expect(isPlain(set, [k], fields)).toBe(false);
    const parked = partsOf(set, [k], fields);
    const off = resetFields(set, [k], fields);
    expect(isPlain(off, [k], fields)).toBe(true);
    expect(find(off, k)!.item.speed).toBeUndefined();
    const back = putParts(off, parked);
    expect(find(back, k)!.item).toMatchObject({ zoom: 1.5, rot: 10, speed: 2 });
    expect(isPlain(setItems(tl, [k], { zoom: 1, crop: [0, 0, 0, 0] }), [k], ["zoom", "crop"])).toBe(true);
  });

  it("sets a clip's fades by its corners: kept inside the clip, on that clip alone, 0 takes it off", () => {
    const tl = reel();
    const k = key(tl, "V1", 0);
    const a = setFade(tl, k, "head", 10.4);
    expect(find(a, k)!.item.fade_in).toBe(10);
    // its linked sound keeps none
    expect(find(a, key(a, "A1", 0))!.item.fade_in).toBeUndefined();
    // in + out never more than the clip's 75 frames
    const b = setFade(a, k, "tail", 200);
    expect(find(b, k)!.item.fade_out).toBe(65);
    expect(setFade(b, k, "tail", 65)).toBe(b);
    const c = setFade(b, k, "head", -5);
    expect("fade_in" in find(c, k)!.item).toBe(false);
    // a locked track: nothing
    const locked = setTrack(tl, "V1", { locked: true });
    expect(setFade(locked, k, "head", 10)).toBe(locked);
    // how much shows: up from 0 over the fade in, down to 0 over the fade out
    const it = { src: "cam", rec: 0, len: 75, in: 0, fade_in: 10, fade_out: 25 };
    expect([0, 5, 10, 40, 50, 62.5, 75].map((f) => fadeAt(it, f))).toEqual([0, 0.5, 1, 1, 1, 0.5, 0]);
  });

  it("a cut keeps the fade in on the left part, the fade out on the right; a save fits fades in the clip", () => {
    const tl = reel();
    const k = key(tl, "V2", 90);
    const faded = setFade(setFade(tl, k, "head", 10), k, "tail", 10);
    const cut = blade(faded, 110, [k]);
    expect(cut.tracks.V2.items.map((i) => [i.fade_in, i.fade_out])).toEqual([[10, undefined], [undefined, 10]]);
    const short = setItems(faded, [k], { len: 12 });
    expect(toSaved(short).tracks.V2.items[0]).toMatchObject({ fade_in: 10, fade_out: 2 });
  });
});

describe("source viewer: marks, the marked part, laying it, looping", () => {
  it("each source keeps its own marks; an Out before a new In goes, ⌥I / ⌥O clear one", () => {
    let all: Record<string, Marks> = {};
    const mark = (path: string, what: Parameters<typeof setMark>[1], f: number) => (all = { ...all, [path]: setMark(all[path] ?? NO_MARKS, what, f) });
    mark("/m/cam.mp4", "in", 10);
    mark("/m/cam.mp4", "out", 40);
    mark("/m/roll.mp4", "out", 5);
    expect(all["/m/cam.mp4"]).toEqual([10, 40]);
    expect(all["/m/roll.mp4"]).toEqual([null, 5]);
    mark("/m/cam.mp4", "in", 50);
    expect(all["/m/cam.mp4"]).toEqual([50, null]);
    expect(setMark([3, 9], "clearIn", 0)).toEqual([null, 9]);
    expect(setMark([3, 9], "clearOut", 0)).toEqual([3, null]);
  });

  it("the marked part runs to the end of the Out frame; In alone runs to the end of the source", () => {
    expect(markedPart([25, 49], 25, 10)).toEqual({ from: 1, to: 2 });
    expect(markedPart([25, null], 25, 10)).toEqual({ from: 1, to: 10 });
    expect(markedPart([null, 24], 25)).toEqual({ from: 0, to: 1 });
    expect(markedPart(NO_MARKS, 25, 10)).toBeUndefined();
  });

  it("a drop of In–Out lays only that part: `in` in the source's frames, `len` in the timeline's", () => {
    expect(clipOfPart("b", 100, 25, 50, { seconds: 8, from: 1, to: 3 })).toEqual({ src: "b", rec: 100, in: 50, len: 50 });
    expect(clipOfPart("b", 0, 25, 50, { seconds: 8 })).toEqual({ src: "b", rec: 0, in: 0, len: 200 });
    expect(clipOfPart("x", 0, 25, 25, {})).toEqual({ src: "x", rec: 0, in: 0, len: 125 });
  });

  it("F9 inserts the marked part at the playhead and pushes what is after; F10 overwrites", () => {
    const tl = reel();
    const item = clipOfPart("b", 50, 25, 50, { from: 1, to: 2 });
    const ins = place(tl, [{ track: "V1", item: { ...item } }, { track: "A1", item: { ...item, link: "x" } }], "insert");
    expect(lengthOf(ins.tl)).toBe(lengthOf(tl) + 25);
    expect(ins.tl.tracks.V1.items.find((i) => i.src === "b")).toMatchObject({ rec: 50, len: 25, in: 50 });
    const over = place(tl, [{ track: "V1", item: { ...item } }], "overwrite");
    expect(lengthOf(over.tl)).toBe(lengthOf(tl));
    expect(over.tl.tracks.V1.items.filter((i) => i.rec < 75 && endOf(i) > 50).map((i) => i.src)).toEqual(["b"]);
  });

  it("F9 / F10 lay on V1 and A1, or on the tracks of the picked clips", () => {
    const tl = reel();
    expect(editTracks(tl, [])).toEqual({ picture: "V1", sound: "A1" });
    expect(editTracks(tl, [key(tl, "V2", 90)])).toEqual({ picture: "V2", sound: "A1" });
    expect(editTracks(tl, [key(tl, "A2", 0)])).toEqual({ picture: "V1", sound: "A2" });
  });

  it("a source plays as a one-clip timeline; a sound file has no picture", () => {
    const s = sourceTimeline("song", { path: "/m/song.m4a" }, { fps: 25, frames: 250, picture: false, sound: true });
    expect(s.tracks.V1.items).toEqual([]);
    expect(lengthOf(s)).toBe(250);
  });

  it("loop: In–Out when both are marked, else the whole length; forward wraps to the start, backward to the end", () => {
    expect(loopPart([25, 49], 250, 25)).toEqual([1, 2]);
    expect(loopPart([25, null], 250, 25)).toEqual([0, 10]);
    expect(loopNext(1.5, 1, [1, 2])).toBe(1.5);
    expect(loopNext(2.02, 1, [1, 2])).toBeCloseTo(1.02);
    expect(loopNext(10.04, 2, [0, 10])).toBeCloseTo(0.04);
    expect(loopNext(0.98, -1, [1, 2])).toBeCloseTo(1.98);
    expect(loopNext(-0.01, -1, [0, 10])).toBeCloseTo(9.99);
    // play pressed far past the Out: straight to the In
    expect(loopNext(7, 1, [1, 2])).toBe(1);
    expect(loopNext(0, -1, [5, 6])).toBeCloseTo(6);
  });
});

// Three Tiny Acrobatics shots on V1 with their voice on A1 (each pair linked), a music bed on A2, and markers. The
// middle shot keys its opacity; the middle and last shots each have a dissolve at the cut before them, their voices a
// crossfade.
const three = (): NleTimeline => {
  const shots: NleItem[] = [
    { src: "cam", rec: 0, len: 50, in: 100, link: 1 },
    { src: "cam", rec: 50, len: 50, in: 300, link: 2, trans: { type: "dissolve", len: 10, at: "center" } },
    { src: "cam", rec: 100, len: 50, in: 500, link: 3, trans: { type: "dissolve", len: 10, at: "center" } },
  ];
  return withKeys({
    timeline: { fps: 25 },
    sources: { cam: { fps: 25, dur: 1000 }, song: { fps: 25 } },
    tracks: {
      V1: { items: shots.map((s, n) => (n === 1 ? { ...s, keys: { opacity: [[300, 0, "linear"], [320, 1, "linear"]] } } : s)) },
      A1: { items: shots.map((s) => ({ ...s, trans: s.trans && { ...s.trans, type: "crossfade" } })) },
      A2: { items: [{ src: "song", rec: 0, len: 150, in: 0 }] },
    },
    markers: [{ frame: 0, name: "L01" }, { frame: 45, name: "in the range", color: "Blue" }, { frame: 70, name: "L02" }, { frame: 140, name: "CTA" }],
  });
};
const at = (tl: NleTimeline, track: string, n: number) => tl.tracks[track].items[n]!;
const marks = (tl: NleTimeline) => (tl.markers ?? []).map((m) => m.frame);
const opacityKeys = [[300, 0, "linear"], [320, 1, "linear"]];

describe("nle model: keys, transitions and markers through every edit", () => {
  it("blade: both parts keep the keys, the transition stays on the left part; split-all skips locked tracks", () => {
    const tl = setTrack(three(), "A2", { locked: true });
    const out = blade(tl, 60);
    expect(spans(out, "V1")).toEqual([[0, 50, 100], [50, 10, 300], [60, 40, 310], [100, 50, 500]]);
    expect(spans(out, "A1")).toEqual(spans(out, "V1"));
    expect(out.tracks.V1.items.slice(1, 3).map((i) => i.keys?.opacity)).toEqual([opacityKeys, opacityKeys]);
    expect(out.tracks.V1.items.map((i) => i.trans?.len)).toEqual([undefined, 10, undefined, 10]);
    expect(out.tracks.A2).toEqual(tl.tracks.A2);
  });

  it("ripple trim: markers after the edit move, the ones on the frames taken out go to the edit point", () => {
    const tl = three();
    // the first shot (and its voice) loses its last 10 frames
    const tail = trim(tl, at(tl, "V1", 0)._k!, "tail", -10, true);
    expect(spans(tail, "V1")).toEqual([[0, 40, 100], [40, 50, 300], [90, 50, 500]]);
    expect(marks(tail)).toEqual([0, 40, 60, 130]);
    expect(at(tail, "V1", 1).trans).toEqual({ type: "dissolve", len: 10, at: "center" });
    expect(at(tail, "V1", 1).keys?.opacity).toEqual(opacityKeys);
    // the middle shot loses its first 10 (the shot before it ending there is not in the way): frames 50-59 go, the
    // marker on them stays at 50
    const t2 = three();
    t2.markers = [{ frame: 55, name: "x" }, { frame: 70, name: "y" }];
    const head = trim(t2, at(t2, "V1", 1)._k!, "head", 10, true);
    expect(spans(head, "V1")).toEqual([[0, 50, 100], [50, 40, 310], [90, 50, 500]]);
    expect(marks(head)).toEqual([50, 60]);
    expect(at(head, "V1", 1).keys?.opacity).toEqual(opacityKeys);
    // a locked track does not move
    const t3 = setTrack(three(), "A2", { locked: true });
    const locked = trim(t3, at(t3, "V1", 0)._k!, "tail", -10, true);
    expect(spans(locked, "A2")).toEqual([[0, 150, 0]]);
  });

  it("ripple delete: markers inside the removed clip go to the edit point, never deleted; a transition with no cut goes", () => {
    const tl = three();
    const out = remove(tl, [at(tl, "V1", 0)._k!], true);
    expect(spans(out, "V1")).toEqual([[0, 50, 300], [50, 50, 500]]);
    expect(marks(out)).toEqual([0, 0, 20, 90]);
    expect(out.markers).toHaveLength(4);
    expect(at(out, "V1", 0).trans).toBeUndefined();
    expect(at(out, "A1", 0).trans).toBeUndefined();
    expect(at(out, "V1", 1).trans?.len).toBe(10);
  });

  it("move, slip, roll, setSpeed, fades and close gap keep keys; transitions follow their cut", () => {
    const tl = three();
    const mid = at(tl, "V1", 1)._k!;
    // moved off its cut: its own transition and the next shot's go
    const moved = move(tl, [mid], 0, { from: "V1", to: "V1" });
    expect(moved).toBe(tl);
    const off = move(tl, [at(tl, "V1", 2)._k!], 5);
    expect(at(off, "V1", 2).trans).toBeUndefined();
    expect(at(off, "A1", 2).trans).toBeUndefined();
    expect(at(off, "V1", 1).trans?.len).toBe(10);
    // slipped to 4 frames from its source's start: its centred dissolve keeps to 2·4 + 1
    const slipped = slip(tl, mid, -296);
    expect(at(slipped, "V1", 1).in).toBe(4);
    expect(at(slipped, "V1", 1).trans?.len).toBe(9);
    expect(at(slipped, "V1", 1).keys?.opacity).toEqual(opacityKeys);
    const rolled = roll(tl, at(tl, "V1", 0)._k!, 5);
    expect(at(rolled, "V1", 1)).toMatchObject({ rec: 55, in: 305, trans: { len: 10 }, keys: { opacity: opacityKeys } });
    const fast = setSpeed(tl, [mid], 2);
    expect(at(fast, "V1", 1).keys?.opacity).toEqual(opacityKeys);
    expect(at(setFades(tl, [mid], "in", 5), "V1", 1).trans?.len).toBe(10);
    const gap = closeGap(off, { track: "V1", from: 100, to: 105 });
    expect(at(gap, "V1", 2).rec).toBe(100);
  });

  it("paste and insert: a pasted clip keeps its keys, its transition only where it lands on a cut", () => {
    const tl = three();
    const clip = copyOf(tl, [at(tl, "V1", 1)._k!]);
    const loose = paste(tl, clip, 300).tl;
    expect(loose.tracks.V1.items.at(-1)).toMatchObject({ rec: 300, keys: { opacity: opacityKeys } });
    expect(loose.tracks.V1.items.at(-1)!.trans).toBeUndefined();
    const onCut = paste(tl, clip, 150).tl;
    expect(onCut.tracks.V1.items.at(-1)).toMatchObject({ rec: 150, trans: { len: 10 } });
    // insert pushes the markers after it
    expect(marks(place(tl, [{ track: "V1", item: { src: "cam", rec: 60, len: 20, in: 0 } }], "insert").tl)).toEqual([0, 45, 90, 160]);
  });

  it("slide: the clip and its voice move between their neighbours, which trim; same frames shown", () => {
    const tl = three();
    const mid = at(tl, "V1", 1)._k!;
    const out = slide(tl, mid, 10);
    expect(spans(out, "V1")).toEqual([[0, 60, 100], [60, 50, 300], [110, 40, 510]]);
    expect(spans(out, "A1")).toEqual(spans(out, "V1"));
    expect(out.tracks.V1.items.map((i) => i.trans?.len)).toEqual([undefined, 10, 10]);
    expect(at(out, "V1", 1).keys?.opacity).toEqual(opacityKeys);
    // stops a frame short of using up the clip before it
    expect(spans(slide(tl, mid, -100), "V1")[0]).toEqual([0, 1, 100]);
    expect(slide(setTrack(tl, "A1", { locked: true }), mid, 10).tracks.V1).toEqual(tl.tracks.V1);
    expect(marks(out)).toEqual(marks(tl));
  });

  it("rate stretch: an end pulled, the same source frames at a new speed; keys stay on what they key", () => {
    const tl = three();
    const mid = at(tl, "V1", 1)._k!;
    const out = rateStretch(tl, mid, "tail", -25);
    expect(at(out, "V1", 1)).toMatchObject({ rec: 50, len: 25, in: 300, speed: 2 });
    expect(at(out, "A1", 1)).toMatchObject({ rec: 50, len: 25, in: 300, speed: 2 });
    // opacity half-way (source frame 310) is now 5 frames in, not 10
    expect(valueAt(at(out, "V1", 1), "opacity", 55, 25, 25)).toBe(0.5);
    expect(valueAt(at(tl, "V1", 1), "opacity", 60, 25, 25)).toBe(0.5);
    // the next shot's cut is gone, so its transition
    expect(at(out, "V1", 2).trans).toBeUndefined();
    // the next clip is in the way; back to its length, the speed is 1 again
    expect(rateStretch(tl, mid, "tail", 10)).toBe(tl);
    expect(at(rateStretch(out, mid, "tail", 25), "V1", 1).speed).toBeUndefined();
    expect(rateStretch(setTrack(tl, "A1", { locked: true }), mid, "tail", -25).tracks.V1).toEqual(tl.tracks.V1);
  });

  it("lift and extract an In/Out range across the unlocked tracks", () => {
    const tl = setTrack(three(), "A2", { locked: true });
    const lifted = lift(tl, 40, 60);
    expect(spans(lifted, "V1")).toEqual([[0, 40, 100], [60, 40, 310], [100, 50, 500]]);
    expect(spans(lifted, "A1")).toEqual(spans(lifted, "V1"));
    expect(spans(lifted, "A2")).toEqual([[0, 150, 0]]);
    expect(at(lifted, "V1", 1).trans).toBeUndefined();
    expect(at(lifted, "V1", 1).keys?.opacity).toEqual(opacityKeys);
    expect(marks(lifted)).toEqual(marks(tl));
    const ex = extract(tl, 40, 60);
    expect(spans(ex, "V1")).toEqual([[0, 40, 100], [40, 40, 310], [80, 50, 500]]);
    expect(spans(ex, "A2")).toEqual([[0, 150, 0]]);
    expect(marks(ex)).toEqual([0, 40, 50, 120]);
    expect(at(ex, "V1", 2).trans?.len).toBe(10);
    expect(lift(tl, 200, 210)).toBe(tl);
  });
});

describe("nle model: timeline markers", () => {
  const tl = (): NleTimeline => withKeys({ timeline: { fps: 25, name: "Tiny Acrobatics" }, sources: {}, tracks: { V1: { items: [] } } });

  it("adds one a frame, in order, and edits, moves and deletes it", () => {
    let t = addMarker(addMarker(tl(), 50), 10.4, { name: "Hook", color: "Red" });
    expect(t.markers).toEqual([{ frame: 10, name: "Hook", color: "Red" }, { frame: 50, name: "Marker 1", color: "Blue" }]);
    expect(addMarker(t, 50)).toBe(t);
    t = setMarker(t, 50, { note: "breath", dur: 12, color: "Lavender" });
    expect(markerAt(t, 61)?.frame).toBe(50);
    expect(markerAt(t, 62)).toBeNull();
    // never onto another marker
    expect(setMarker(t, 50, { frame: 10 })).toBe(t);
    t = setMarker(t, 50, { frame: 5, note: "", dur: 1 });
    expect(t.markers).toEqual([{ frame: 5, name: "Marker 1", color: "Lavender" }, { frame: 10, name: "Hook", color: "Red" }]);
    expect(removeMarker(t, 5).markers).toEqual([{ frame: 10, name: "Hook", color: "Red" }]);
    expect(removeMarker(t, 7)).toBe(t);
  });

  it("exports a CSV: timecode, name, colour, note, duration, quoted where a cell needs it", () => {
    const t = setMarker(addMarker(addMarker(tl(), 3700 * 25 + 3, { name: "End" }), 30, { name: 'Hook, "big"' }), 30, { note: "two\nlines", dur: 50 });
    expect(markersCsv(t)).toBe('Timecode,Name,Colour,Note,Duration\n00:00:01:05,"Hook, ""big""",Blue,"two\nlines",00:00:02:00\n01:01:40:03,End,Blue,,00:00:00:01\n');
  });
});

describe("nle model: processing, the timeline's setting and a clip's own", () => {
  const withVoice = () => {
    const tl = setTimelineProcessing(reel(), "voice", { fx: "a", share: 0.6 });
    return setClipProcessing(tl, [key(tl, "A1", 0)], "voice", { fx: "b", share: 1 });
  };

  it("a clip follows the timeline unless it has its own; off again it follows the timeline", () => {
    const tl = withVoice();
    const [own, other] = tl.tracks.A1.items;
    expect(processingOf(tl, own, "voice")).toEqual({ fx: "b", share: 1 });
    expect(processingOf(tl, other, "voice")).toEqual({ fx: "a", share: 0.6 });
    expect(processingOf(tl, other, "face")).toBeUndefined();
    const back = setClipProcessing(tl, [own._k!], "voice", undefined);
    expect(find(back, own._k!)!.item.processing).toBeUndefined();
    expect(processingOf(back, find(back, own._k!)!.item, "voice")).toEqual({ fx: "a", share: 0.6 });
    // another processing on the same clip stays when one goes
    const two = setClipProcessing(setClipProcessing(tl, [own._k!], "face", { on: true }), [own._k!], "voice", undefined);
    expect(find(two, own._k!)!.item.processing).toEqual({ face: { on: true } });
    expect(setTimelineProcessing(tl, "voice", undefined).timeline.processing).toBeUndefined();
    expect(toSaved(tl).timeline.processing).toEqual({ voice: { fx: "a", share: 0.6 } });
  });

  it("a locked track is left alone, and each clip gets its own copy", () => {
    const tl = withVoice();
    tl.tracks.A1.locked = true;
    expect(setClipProcessing(tl, [key(tl, "A1", 75)], "voice", { fx: "c" })).toBe(tl);
    const v = { fx: "c" };
    const r = reel();
    const both = setClipProcessing(r, [key(r, "A1", 0), key(r, "A1", 75)], "voice", v);
    v.fx = "changed";
    const [a, b] = both.tracks.A1.items;
    expect(a.processing).not.toBe(b.processing);
    expect(a.processing!.voice).not.toBe(b.processing!.voice);
    expect(a.processing!.voice).toEqual({ fx: "c" });
  });

  it("every edit keeps a clip's own setting: blade, duplicate, paste, ripple delete, slide, rate stretch, save", () => {
    const tl = withVoice();
    const k = key(tl, "A1", 0);
    const own = { voice: { fx: "b", share: 1 } };
    const cut = blade(tl, 30, [k]);
    expect(cut.tracks.A1.items.filter((i) => i.rec < 75).map((i) => i.processing)).toEqual([own, own]);
    // the right part's setting is its own: changing one never changes the other
    const right = cut.tracks.A1.items.find((i) => i.rec === 30)!;
    const changed = setClipProcessing(cut, [right._k!], "voice", { fx: "c" });
    expect(changed.tracks.A1.items.find((i) => i.rec === 0)!.processing).toEqual(own);
    const dup = duplicate(tl, [k]);
    expect(dup.keys.map((d) => find(dup.tl, d)!.item.processing).filter(Boolean)).toEqual([own]);
    const pasted = paste(tl, copyOf(tl, [k]), 200);
    expect(pasted.keys.map((p) => find(pasted.tl, p)!.item.processing).filter(Boolean)).toEqual([own]);
    const after = key(tl, "A1", 75);
    const rippled = remove(tl, [key(tl, "V1", 0)], true);
    expect(find(rippled, after)!.item.processing).toBeUndefined();
    const second = setClipProcessing(tl, [after], "voice", { fx: "c" });
    expect(find(remove(second, [key(tl, "V1", 0)], true), after)!.item.processing).toEqual({ voice: { fx: "c" } });
    const slid = setClipProcessing(tl, [key(tl, "V2", 90)], "face", { on: true });
    expect(find(slide(slid, key(tl, "V2", 90), 5), key(tl, "V2", 90))!.item.processing).toEqual({ face: { on: true } });
    expect(find(rateStretch(tl, k, "tail", -10), k)!.item.processing).toEqual(own);
    expect(toSaved(tl).tracks.A1.items[0].processing).toEqual(own);
  });
});
