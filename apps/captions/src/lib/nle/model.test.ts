import { describe, expect, it } from "vitest";
import {
  addSource, addTrack, isPlain, partsOf, putParts, resetFields, setFades, blade, clipsFrom, copyOf, duplicate, endOf, extendTo, find, freeTrack, lengthOf, move, rippleToPlayhead, paste, place, remove, deleteTrack, roll,
  fadeAt, setFade, setItems, setSpeed, setTrack, slip, timecode, toSaved, trim, unlink, withKeys, type NleTimeline,
  NO_MARKS, clipOfPart, editTracks, loopNext, loopPart, markedPart, setMark, sourceTimeline, type Marks,
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
