import { describe, expect, it } from "vitest";
import { COMMANDS, clipOfRef, commandLines, runAll, stateView, type NleState } from "./commands";
import { commandOfKey, KEYS, type KeyAction } from "./keys";
import { blade, clipsFrom, closeGap, copyOf, endOf, find, lengthOf, move, NO_MARKS, paste, remove, rippleToPlayhead, setItems, setMark, setTrack, toSaved, withKeys, type NleTimeline } from "./model";

// A reel: two talking shots on V1 with their voice on A1 (linked), a B-roll clip on V2 and a song on A2.
const reel = (): NleTimeline =>
  withKeys({
    timeline: { fps: 25, name: "Tiny Acrobatics reel" },
    sources: { cam: { path: "/m/cam.mp4", fps: 25, dur: 1000 }, b: { path: "/m/roll.mp4", fps: 50, dur: 400 }, song: { path: "/m/song.m4a", fps: 25 } },
    tracks: {
      V1: { items: [{ src: "cam", rec: 0, len: 75, in: 100, link: 1 }, { src: "cam", rec: 75, len: 75, in: 400, link: 2 }] },
      A1: { items: [{ src: "cam", rec: 0, len: 75, in: 100, link: 1 }, { src: "cam", rec: 75, len: 75, in: 400, link: 2 }] },
      V2: { items: [{ src: "b", rec: 90, len: 40, in: 0, name: "Rolls" }] },
      A2: { items: [{ src: "song", rec: 0, len: 150, in: 0 }] },
    },
  });
const key = (tl: NleTimeline, track: string, rec: number) => tl.tracks[track].items.find((i) => i.rec === rec)!._k!;
const stateOf = (tl: NleTimeline, o: Partial<NleState> = {}): NleState => ({ tl, sel: [], playhead: 0, marks: NO_MARKS, ...o });
const press = (a: KeyAction, s: NleState) => {
  const k = commandOfKey(a);
  return COMMANDS[k.id].run(s, k.params);
};

// every KeyAction, so tsc fails here when keys.ts gains one
const ACTIONS: Record<Exclude<KeyAction, `lock:${string}`>, true> = {
  play: true, stop: true, forward: true, reverse: true, save: true, undo: true, redo: true, split: true, copy: true, cut: true, paste: true,
  duplicate: true, selectAll: true, deselect: true, selectForward: true, selectBack: true, rippleStart: true, rippleEnd: true, delete: true,
  rippleDelete: true, enable: true, markIn: true, markOut: true, clearMarks: true, toolSelect: true, toolTrim: true, toolBlade: true, snap: true,
  linkedSelection: true, nudgeBack: true, nudgeBack5: true, nudgeOn: true, nudgeOn5: true, frameBack: true, frameOn: true, secondBack: true,
  secondOn: true, prevEdit: true, nextEdit: true, start: true, end: true, zoomIn: true, zoomOut: true, zoomFit: true, mediaPool: true,
  inspector: true, clearIn: true, clearOut: true, insertEdit: true, overwriteEdit: true, loop: true,
};

describe("nle commands", () => {
  it("has a command for every key", () => {
    for (const a of [...Object.keys(ACTIONS), ...Object.values(KEYS)] as KeyAction[]) expect(COMMANDS[commandOfKey(a).id], a).toBeDefined();
    expect(commandOfKey("lock:V3")).toEqual({ id: "lock", params: { track: 3 } });
  });

  it("runs each key as the editor did", () => {
    const tl = reel();
    const v1b = key(tl, "V1", 75);
    const b = key(tl, "V2", 90);
    // W: the picked clip under the playhead, or every clip under it
    // (a cut's right part gets a new handle each time: compared as saved)
    expect(toSaved(press("split", stateOf(tl, { playhead: 100 })).tl)).toEqual(toSaved(blade(tl, 100)));
    expect(toSaved(press("split", stateOf(tl, { playhead: 100, sel: [b] })).tl)).toEqual(toSaved(blade(tl, 100, [b])));
    // Q: ripple to the playhead, which goes to the cut
    const q = press("rippleStart", stateOf(tl, { playhead: 100, sel: [v1b] }));
    expect(q.tl).toEqual(rippleToPlayhead(tl, 100, "head", [v1b]));
    expect(q.playhead).toBe(75);
    expect(press("rippleEnd", stateOf(tl, { playhead: 100 })).tl).toEqual(rippleToPlayhead(tl, 100, "tail", []));
    // delete, ripple delete, and a picked gap closed
    expect(press("delete", stateOf(tl, { sel: [b] })).tl).toEqual(remove(tl, [b]));
    expect(press("rippleDelete", stateOf(tl, { sel: [b] })).tl).toEqual(remove(tl, [b], true));
    const gap = { track: "V2", from: 0, to: 90 };
    expect(press("rippleDelete", stateOf(tl, { gap })).tl).toEqual(closeGap(tl, gap));
    // nudges move the picked clips and their linked ones
    expect(press("nudgeOn5", stateOf(tl, { sel: [v1b] })).tl).toEqual(move(tl, [v1b], 5));
    expect(press("nudgeBack", stateOf(tl, { sel: [b] })).tl).toEqual(move(tl, [b], -1));
    expect(press("enable", stateOf(tl, { sel: [b] })).tl).toEqual(setItems(tl, [b], { enabled: false }));
    // copy, then paste at the playhead (overwrite) picks what it laid
    const copied = press("copy", stateOf(tl, { sel: [b] }));
    expect(copied.clipboard).toEqual(copyOf(tl, [b]));
    const pasted = press("paste", { ...copied, playhead: 10 });
    expect(pasted.tl.tracks.V2.items.map((i) => [i.rec, i.len])).toEqual(paste(tl, copyOf(tl, [b]), 10).tl.tracks.V2.items.map((i) => [i.rec, i.len]));
    expect(pasted.sel).toHaveLength(1);
    expect(press("cut", stateOf(tl, { sel: [b] })).tl).toEqual(remove(tl, [b]));
    expect(press("selectForward", stateOf(tl, { playhead: 100 })).sel).toEqual(clipsFrom(tl, 100, 1));
    expect(press("selectAll", stateOf(tl)).sel).toHaveLength(6);
    // marks at the playhead
    expect(press("markIn", stateOf(tl, { playhead: 20 })).marks).toEqual(setMark(NO_MARKS, "in", 20));
    expect(press("clearMarks", stateOf(tl, { marks: [1, 5] })).marks).toEqual(NO_MARKS);
    // the playhead
    expect(press("nextEdit", stateOf(tl, { playhead: 80 })).playhead).toBe(90);
    expect(press("prevEdit", stateOf(tl, { playhead: 80 })).playhead).toBe(75);
    expect(press("secondOn", stateOf(tl)).playhead).toBe(25);
    expect(press("frameBack", stateOf(tl)).playhead).toBe(0);
    expect(press("end", stateOf(tl)).playhead).toBe(lengthOf(tl) - 1);
    expect(press("lock:V2", stateOf(tl)).tl).toEqual(setTrack(tl, "V2", { locked: true }));
    // the keys the page test does not press
    const dup = press("duplicate", stateOf(tl, { sel: [b] }));
    expect(dup.tl.tracks.V2.items).toHaveLength(2);
    expect(dup.sel).toHaveLength(1);
    expect(press("deselect", stateOf(tl, { sel: [b] })).sel).toEqual([]);
    expect(press("selectBack", stateOf(tl, { playhead: 100 })).sel).toEqual(clipsFrom(tl, 100, -1));
    expect(press("markOut", stateOf(tl, { playhead: 30 })).marks).toEqual(setMark(NO_MARKS, "out", 30));
    expect(press("clearIn", stateOf(tl, { marks: [1, 5] })).marks).toEqual([null, 5]);
    expect(press("clearOut", stateOf(tl, { marks: [1, 5] })).marks).toEqual([1, null]);
    expect(press("frameOn", stateOf(tl)).playhead).toBe(1);
    expect(press("secondBack", stateOf(tl, { playhead: 30 })).playhead).toBe(5);
    expect(press("start", stateOf(tl, { playhead: 30 })).playhead).toBe(0);
    // what the page does itself changes nothing here
    for (const a of ["play", "save", "undo", "zoomIn", "insertEdit", "loop"] as const) expect(press(a, stateOf(tl))).toEqual(stateOf(tl));
  });

  it("makes it 26 s: V1's last shot and its voice run on; shorter cuts every track", () => {
    const tl = reel();
    const longer = runAll(stateOf(tl), [{ id: "setLength", params: { seconds: 8 } }]).tl;
    expect(endOf(longer.tracks.V1.items[1])).toBe(200);
    expect(endOf(longer.tracks.A1.items[1])).toBe(200);
    expect(longer.tracks.A2.items[0].len).toBe(150);
    const shorter = runAll(stateOf(tl), [{ id: "setLength", params: { seconds: 4 } }]).tl;
    expect(lengthOf(shorter)).toBe(100);
    expect(Object.values(shorter.tracks).flatMap((t) => t.items).every((i) => endOf(i) <= 100)).toBe(true);
    expect(shorter.tracks.V2.items.map((i) => [i.rec, i.len])).toEqual([[90, 10]]);
  });

  it("runs the chat's list as one edit, refs read before it, all or none", () => {
    const tl = reel();
    expect(clipOfRef(tl, "V1:2")).toBe(key(tl, "V1", 75));
    expect(clipOfRef(tl, "V9:1")).toBeNull();
    // "move the B-roll two frames later", then lock V2
    const s = runAll(stateOf(tl), [{ id: "move", params: { frames: 2 }, ref: "V2:1" }, { id: "lock", params: { track: 2 } }]);
    expect(s.tl.tracks.V2.items[0].rec).toBe(92);
    expect(s.tl.tracks.V2.locked).toBe(true);
    expect(runAll(stateOf(tl), [{ id: "seek", params: { seconds: 2 } }]).playhead).toBe(50);
    expect(() => runAll(stateOf(tl), [{ id: "seek", params: { seconds: 2 } }, { id: "nudgeOn" }])).toThrow("Command 2 (nudgeOn): nothing to do it on");
    expect(() => runAll(stateOf(tl), [{ id: "save" }])).toThrow("not a command here");
    expect(() => runAll(stateOf(tl), [{ id: "setLength" }])).toThrow("needs seconds");
    expect(() => runAll(stateOf(tl), [{ id: "move", ref: "V7:1", params: { frames: 1 } }])).toThrow("no clip V7:1");
    expect(() => runAll(stateOf(tl), [{ id: "move", ref: "V2:1" }])).toThrow("give frames or seconds");
    expect(find(tl, key(tl, "V2", 90))!.item.rec).toBe(90); // nothing changed the timeline it was given
  });

  it("shows the timeline to the chat as refs and seconds, and lists only its own commands", () => {
    const tl = reel();
    const v = stateView(stateOf(tl, { sel: [key(tl, "V2", 90)], playhead: 50, marks: [25, null] }));
    expect(v).toMatchObject({ fps: 25, length: 6, playhead: 2, in: 1, out: null, selection: ["V2:1"] });
    expect(v.tracks.V2.clips).toEqual([{ ref: "V2:1", rec: 3.6, len: 1.6, name: "Rolls", src: "roll.mp4" }]);
    expect(JSON.stringify(v)).not.toContain("_k");
    const lines = commandLines();
    expect(lines).toContain("setLength(seconds: the new length in seconds)");
    expect(lines).not.toMatch(/^save\b|^play\b|^undo\b/m);
  });
});
