import { describe, expect, it } from "vitest";
import type { Cue, Word } from "../types";
import { captionsStale, fromOf, remapCaptions, type From } from "./captions";
import type { NleTimeline } from "./model";

// 30 fps, one recording "s1": the old cut plays frames 0–89 of it, then frames 200–289
const FPS = 30;
const OLD: From[] = [[0, 90, "s1", 0], [90, 90, "s1", 200]];
const w = (id: number, text: string, start: number, end = start + 0.3): Word => ({ id, text, start, end });
const WORDS = [w(1, "Tiny", 1), w(2, "acrobats", 2.5), w(3, "flip", 3.5), w(4, "today", 4.5)];
const cue = (id: number, words: Word[], lines?: number[]): Cue => ({ id, start: words[0]!.start, end: words.at(-1)!.end, words, ...(lines ? { lines } : {}) });
const DATA = { words: WORDS, cues: [cue(1, [WORDS[0]!]), cue(2, [WORDS[1]!, WORDS[2]!], [1, 1]), cue(3, [WORDS[3]!])], style: { fontFamily: "Anton" }, peaks: [0.1] };
const texts = (r: ReturnType<typeof remapCaptions>) => r.data.cues!.map((c) => [c.words.map((x) => x.text).join(" "), c.start, c.end]);

describe("captions from an older cut", () => {
  const tl = (items: { rec: number; len: number; src: string; in: number; enabled?: boolean }[], from = OLD) =>
    ({ tracks: { V1: { items: [] }, A1: { items } }, captions: { project: "p", clip: "c", burn: false, from } }) as unknown as NleTimeline;
  const cut = OLD.map(([rec, len, src, inn]) => ({ rec, len, src, in: inn }));

  it("is derived from A1: the same clips are current, a trim or a moved clip is not", () => {
    expect(fromOf(tl(cut))).toEqual(OLD);
    expect(captionsStale(tl(cut))).toBe(false);
    expect(captionsStale(tl([cut[0]!, { ...cut[1]!, len: 80 }]))).toBe(true);
    expect(captionsStale(tl([cut[0]!, { ...cut[1]!, rec: 100 }]))).toBe(true);
    // a clip switched off doesn't play, so it isn't in the cut
    expect(captionsStale(tl([...cut, { rec: 180, len: 30, src: "s1", in: 400, enabled: false }]))).toBe(false);
    expect(captionsStale({ tracks: { A1: { items: cut } } } as unknown as NleTimeline)).toBe(false);
  });
});

describe("Update Captions moves his captions by source frames", () => {
  it("the same cut: everything stays, nothing to hear", () => {
    const r = remapCaptions(DATA, OLD, OLD, FPS);
    expect(r.fill).toEqual([]);
    expect(r.data.cues).toEqual(DATA.cues);
    expect(r.data.style).toEqual(DATA.style);
    // the old cut's waveform goes: Caption Studio draws the new one
    expect(r.data.peaks).toBeUndefined();
  });

  it("moved material: the two parts swapped, their words go with them and a line across the cut splits", () => {
    const r = remapCaptions(DATA, OLD, [[0, 90, "s1", 200], [90, 90, "s1", 0]], FPS);
    expect(texts(r)).toEqual([["flip", 0.5, 0.8], ["today", 1.5, 1.8], ["Tiny", 4, 4.3], ["acrobats", 5.5, 5.8]]);
    // split lines wrap to width again; ids are numbered in the new order
    expect(r.data.cues!.every((c) => !c.lines)).toBe(true);
    expect(r.data.cues!.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(r.data.words!.map((x) => [x.id, x.text])).toEqual([[1, "flip"], [2, "today"], [3, "Tiny"], [4, "acrobats"]]);
    expect(r.data.cues!.flatMap((c) => c.words.map((x) => x.id))).toEqual([1, 2, 3, 4]);
    expect(r.fill).toEqual([]);
  });

  it("trimmed: words cut off go, the rest keep their place in the recording", () => {
    // the first part's head trimmed by 1.5 s (the timeline closes up), the second's tail by 1⅔ s: both parts move
    // together, so the line across the cut stays whole with its lines
    const r = remapCaptions(DATA, OLD, [[0, 45, "s1", 45], [45, 40, "s1", 200]], FPS);
    expect(texts(r)).toEqual([["acrobats flip", 1, 2.3]]);
    expect(r.data.cues![0]!.lines).toEqual([1, 1]);
  });

  it("removed: the second part taken out, its words with it", () => {
    const r = remapCaptions(DATA, OLD, [[0, 90, "s1", 0]], FPS);
    expect(texts(r)).toEqual([["Tiny", 1, 1.3], ["acrobats", 2.5, 2.8]]);
  });

  it("split with nothing moved: a line across the blade stays one line, with its lines", () => {
    const r = remapCaptions(DATA, OLD, [[0, 80, "s1", 0], [80, 10, "s1", 80], [90, 90, "s1", 200]], FPS);
    expect(r.data.cues).toEqual(DATA.cues);
  });

  it("new material: only what no old clip had is heard, and his word fixes stay", () => {
    const fixed = { ...DATA, words: DATA.words.map((x) => (x.id === 1 ? { ...x, text: "Tinyy" } : x)), cues: [{ ...DATA.cues[0]!, words: [{ ...WORDS[0]!, text: "Tinyy" }] }, ...DATA.cues.slice(1)] };
    // the second part runs 1 s longer, and a new recording "s2" is put at the end
    const r = remapCaptions(fixed, OLD, [[0, 90, "s1", 0], [90, 120, "s1", 200], [210, 30, "s2", 0]], FPS);
    expect(r.fill).toEqual([[6, 8]]);
    expect(texts(r)[0]).toEqual(["Tinyy", 1, 1.3]);
    expect(r.data.cues![1]!.lines).toEqual([1, 1]);
  });

  it("material used twice: its words twice", () => {
    const r = remapCaptions(DATA, OLD, [[0, 90, "s1", 0], [90, 90, "s1", 0]], FPS);
    expect(texts(r).map((c) => c[0])).toEqual(["Tiny", "acrobats", "Tiny", "acrobats"]);
    expect(new Set(r.data.words!.map((x) => x.id)).size).toBe(4);
  });

  it("a source at another frame rate maps through its own frames", () => {
    // s1 at 60 fps: `in` counts its frames, two to a timeline frame
    const from: From[] = [[0, 90, "s1", 0], [90, 90, "s1", 400]];
    const r = remapCaptions(DATA, from, [[0, 90, "s1", 400]], FPS, () => 2);
    expect(texts(r)).toEqual([["flip", 0.5, 0.8], ["today", 1.5, 1.8]]);
  });

  it("texts on screen move with their start; one whose start was cut out goes", () => {
    const t = (id: number, start: number) => ({ id, text: "Tiny", start, end: start + 1 }) as never;
    const r = remapCaptions({ ...DATA, texts: [t(1, 1), t(2, 4)] }, OLD, [[0, 90, "s1", 200]], FPS);
    expect(r.data.texts!.map((x) => [x.start, x.end])).toEqual([[1, 2]]);
  });
});

describe("the registry's caption commands", async () => {
  const { COMMANDS } = await import("./commands");
  const items = OLD.map(([rec, len, src, inn]) => ({ src, rec, len, in: inn }));
  const state = (captions?: object, a1 = items) => ({ tl: { timeline: { fps: FPS }, sources: {}, tracks: { A1: { items: a1 } }, ...(captions ? { captions } : {}) } as unknown as NleTimeline, sel: [], playhead: 0, marks: [null, null] as [null, null] });
  const link = { project: "p", clip: "c", burn: false, from: OLD };

  it("Make Captions only without captions, Update Captions only from an older cut; both ask the page", () => {
    expect(COMMANDS.makeCaptions.enabled(state())).toBe(true);
    expect(COMMANDS.makeCaptions.enabled(state(link))).toBe(false);
    expect(COMMANDS.makeCaptions.run(state(), {}).captionsAsk).toBe("make");
    expect(COMMANDS.updateCaptions.enabled(state(link))).toBe(false);
    const older = state(link, [items[0]!]);
    expect(COMMANDS.updateCaptions.enabled(older)).toBe(true);
    expect(COMMANDS.updateCaptions.run(older, {}).captionsAsk).toBe("update");
  });

  it("burn in: on, off, or switched", () => {
    expect(COMMANDS.burnCaptions.enabled(state())).toBe(false);
    expect(COMMANDS.burnCaptions.run(state(link), {}).tl.captions!.burn).toBe(true);
    expect(COMMANDS.burnCaptions.run(state(link), { on: 0 }).tl.captions).toEqual(link);
    expect(COMMANDS.burnCaptions.run(state({ ...link, burn: true }), { on: 1 }).tl.captions!.burn).toBe(true);
  });
});
