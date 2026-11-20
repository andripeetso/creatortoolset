import { describe, expect, it } from "vitest";
import { PICTURE_SIDE_MAX } from "@contracts/design";
import { runAll } from "./commands";
import { NO_MARKS, withKeys, type NleTimeline } from "./model";
import { canGrab, designFile, placeText, renderScale } from "./text-clip";

// Text clips are Design frames on the timeline: where New Text lays one, what plays it, how big its PNG is drawn, and
// which frames may be drawn into a design.

const tl = (more: Partial<NleTimeline["tracks"]> = {}): NleTimeline => withKeys({
  timeline: { fps: 25, width: 2160, height: 3840 },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 }, b: { path: "/m/b.mp4", fps: 25, dur: 500 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 300, in: 0 }] }, A1: { items: [] }, ...more },
} as NleTimeline);
const made = { kind: "design", design: "d1", frame: "p1", path: "/data/designs/jordan/d1/renders/0123456789abcdef0123.png", w: 2160, h: 3840 };

describe("New Text", () => {
  it("lays 5 s at the playhead on the first free picture track above V1, a new one when they are all taken", () => {
    const one = placeText(tl(), made, 50);
    expect(one.tl.tracks.V2!.items).toEqual([expect.objectContaining({ src: "text1", rec: 50, len: 125, in: 0, _k: one.key })]);
    expect(one.tl.tracks.V1!.items).toHaveLength(1);
    // V2 taken there, V3 free: V3; a second text gets its own source
    const taken = tl({ V2: { items: [{ src: "b", rec: 100, len: 10, in: 0 }] }, V3: { items: [] } });
    const two = placeText(taken, made, 60);
    expect(two.tl.tracks.V3!.items[0]).toMatchObject({ src: "text1", rec: 60 });
    expect(placeText(two.tl, made, 200).tl.tracks.V2!.items.find((i) => i.src === "text2")).toMatchObject({ rec: 200 });
    // a locked track is passed over
    const locked = placeText(tl({ V2: { items: [], locked: true } }), made, 0);
    expect(locked.tl.tracks.V3!.items).toHaveLength(1);
  });

  it("the chat's newText lays a pending text with its words and picks it", () => {
    const s = runAll({ tl: tl(), sel: [], playhead: 25, marks: NO_MARKS }, [{ id: "newText", params: { words: "Tiny Acrobatics" } }]);
    const it = s.tl.tracks.V2!.items[0]!;
    expect(s.sel).toEqual([it._k]);
    expect(s.tl.sources[it.src]).toEqual({ kind: "design", pending: expect.any(String), words: "Tiny Acrobatics", w: 2160, h: 3840 });
  });
});

describe("what a text clip plays", () => {
  it("its PNG from the server by the file's name; nothing while it is made; a red clip once its design is gone", () => {
    expect(designFile(made, new Set())).toEqual({ url: "/api/designs/d1/renders/0123456789abcdef0123.png", grab: true });
    expect(designFile({ kind: "design", pending: "x", words: "" }, new Set())).toEqual({ url: "", why: "Drawing the text" });
    expect(designFile({ kind: "design", failed: "An account holds up to 300 designs: delete one first" }, new Set()).why).toContain("300 designs");
    expect(designFile(made, new Set([made.path]))).toEqual({ url: "", why: "Its design was deleted" });
  });

  it("is drawn at the largest zoom its clips reach, never past the picture size cap", () => {
    const t = tl({ V2: { items: [{ src: "t", rec: 0, len: 10, in: 0 }] } });
    expect(renderScale(t, "t", 2160, 3840)).toBe(1);
    t.tracks.V2!.items[0]!.zoom = 0.5;
    expect(renderScale(t, "t", 2160, 3840)).toBe(1);
    t.tracks.V2!.items[0]!.keys = { zoom: [[0, 1, "ease"], [9, 1.8, "ease"]] };
    expect(renderScale(t, "t", 2160, 3840)).toBe(1.8);
    // UHD at 3×: held to 8192 a side
    t.tracks.V2!.items[0]!.zoom = 3;
    const k = renderScale(t, "t", 2160, 3840);
    expect(Math.round(3840 * k)).toBe(PICTURE_SIDE_MAX);
    expect(Math.round(2160 * k)).toBeLessThanOrEqual(PICTURE_SIDE_MAX);
  });
});

describe("Design on This Frame: only blurred copies, own files and designs", () => {
  const over = tl({ V2: { items: [{ src: "b", rec: 0, len: 50, in: 0 }] } });
  const files = (marked: Record<string, boolean>) => (src: string) => ({ url: `/m/${src}.mp4`, ...(marked[src] ? { grab: true as const } : {}) });

  it("greys a frame where any picture is a file the page didn't mark (a catalog original), or nothing shows", () => {
    expect(canGrab(tl(), 10, files({}))).toBe(false);
    expect(canGrab(over, 10, files({ a: true }))).toBe(false);
    expect(canGrab(tl(), 400, files({ a: true }))).toBe(false);
    // marked, but it doesn't play here
    expect(canGrab(tl(), 10, () => ({ url: "", grab: true }))).toBe(false);
  });

  it("takes a frame of blurred or own files, with text clips over them", () => {
    expect(canGrab(tl(), 10, files({ a: true }))).toBe(true);
    expect(canGrab(over, 10, files({ a: true, b: true }))).toBe(true);
    // past V2's clip only V1 shows
    expect(canGrab(over, 60, files({ a: true }))).toBe(true);
    const text = placeText(tl(), made, 0).tl;
    expect(canGrab(text, 10, files({ a: true }))).toBe(true);
  });

  it("a shot's other pictures count too: an inset's shot under it is checked", () => {
    const shot = tl();
    shot.tracks.V1!.items[0]!.under = { src: "b", in: 0 };
    expect(canGrab(shot, 10, files({ a: true }))).toBe(false);
    expect(canGrab(shot, 10, files({ a: true, b: true }))).toBe(true);
  });
});
