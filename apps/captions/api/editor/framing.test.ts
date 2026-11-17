import { describe, expect, it } from "vitest";
import type { TimelineSource } from "../../contracts/editor";
import { fillZoom, fitted, followPath, framingOf, maxPunch, panKeys, pathAt, pathIn, reframeTimeline, speakerPath, speakerTargets, tiltFor, windowOf } from "./framing";
import { pathExpr } from "./preview";
import { reframeSpan } from "./timeline";

const src = (w: number, h: number): TimelineSource => ({ versionId: "v", name: "Take A", fps: 25, tc: 0, dur: 100, w, h });
const W = 1080;
const H = 1920;
/** Where the picture's top and bottom edges land on screen (y down), and a source line at fraction y. */
function onScreen(s: TimelineSource, zoom: number, tilt: number, y: number) {
  const { h } = fitted(s, W, H);
  const at = (f: number) => H / 2 + zoom * (f - 0.5) * h - tilt;
  return { top: at(0), bottom: at(1), line: at(y) };
}

describe("AI Editor framing", () => {
  it("punches in on every other shot, holding the eye line where it was", () => {
    const s = src(1080, 1920);
    expect(framingOf(0, s, W, H, 1.15, 0.38)).toEqual({});
    const f = framingOf(1, s, W, H, 1.15, 0.38);
    expect(f.zoom).toBe(1.15);
    expect(onScreen(s, f.zoom!, f.tilt!, 0.38).line).toBeCloseTo(onScreen(s, 1, 0, 0.38).line, 1);
    expect(framingOf(2, s, W, H, 1.15, 0.38)).toEqual({});
  });

  it("caps the punch by the source's size: 1.5 under 4K, 2.0 from 4K", () => {
    expect(maxPunch(src(1080, 1920))).toBe(1.5);
    expect(maxPunch(src(2160, 3840))).toBe(2);
    expect(framingOf(1, src(1080, 1920), W, H, 2, 0.5)).toEqual({ zoom: 1.5 });
  });

  it("never shows an edge at the clamp, with the eye line at the very top or bottom", () => {
    for (const s of [src(1080, 1920), src(2160, 3840)]) {
      const z = maxPunch(s);
      for (const y of [0, 1]) {
        const e = onScreen(s, z, tiltFor(s, W, H, z, y), y);
        expect(e.top).toBeLessThanOrEqual(0.01);
        expect(e.bottom).toBeGreaterThanOrEqual(H - 0.01);
      }
    }
  });

  it("keeps a wide shot in a tall frame inside the frame", () => {
    const s = src(1920, 1080);
    for (const y of [0, 1]) {
      const e = onScreen(s, 1.5, tiltFor(s, W, H, 1.5, y), y);
      expect(e.top).toBeGreaterThanOrEqual(-0.01);
      expect(e.bottom).toBeLessThanOrEqual(H + 0.01);
    }
  });
});

describe("reframing: a crop window that follows the subject", () => {
  const every = (from: number, to: number, c: (t: number) => number, step = 0.1) =>
    Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => ({ t: from + i * step, c: c(from + i * step) }));

  it("fills a 9:16, 1:1 and 4:5 frame from 16:9 with a window of the frame's own shape", () => {
    const wide = src(1920, 1080);
    for (const [w, h] of [[1080, 1920], [1080, 1080], [1080, 1350]] as const) {
      const z = fillZoom(wide, w, h);
      const f = fitted(wide, w, h);
      expect(f.h * z).toBeCloseTo(h);
      expect(windowOf(wide, w, h, z)).toBeCloseTo((w / h) / (16 / 9));
    }
  });

  it("holds still while the subject sways near the middle: no jitter", () => {
    const keys = followPath(every(0, 10, (t) => 0.5 + 0.02 * Math.sin(t * 7)), 0.32);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.x).toBeCloseTo(0.5, 1);
  });

  it("moves once the subject has been off the middle for a while, eased, then holds again", () => {
    // the subject walks from 0.3 to 0.7 between 2 s and 4 s, then stays
    const keys = followPath(every(0, 10, (t) => (t < 2 ? 0.3 : t > 4 ? 0.7 : 0.3 + 0.2 * (t - 2))), 0.32);
    expect(keys[0]!.x).toBeCloseTo((0.3 - 0.16) / 0.68, 3);
    expect(keys.at(-1)!.x).toBeCloseTo((0.7 - 0.16) / 0.68, 2);
    // a few moves, each starting where the last one ended, never back the other way
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.x).toBeGreaterThanOrEqual(keys[i - 1]!.x);
    expect(keys.length).toBeLessThanOrEqual(9);
    // nothing moves before the subject has been off the middle for HOLD
    expect(pathAt(keys, 2.4)).toBeCloseTo(keys[0]!.x);
  });

  it("cuts to a new speaker at once, and does not cut for one inside the window", () => {
    const targets = [...every(0, 3, () => 0.25), ...every(3.1, 6, () => 0.75).map((s, i) => (i ? s : { ...s, jump: true }))];
    const keys = followPath(targets, 0.32);
    expect(keys).toEqual([{ t: 0, x: (0.25 - 0.16) / 0.68 }, { t: 3.1, x: (0.25 - 0.16) / 0.68 }, { t: 3.1, x: (0.75 - 0.16) / 0.68 }].map((k) => ({ t: k.t, x: Math.round(k.x * 1e4) / 1e4 })));
    expect(pathAt(keys, 3.09)).toBeCloseTo(keys[0]!.x);
    expect(pathAt(keys, 3.1)).toBeCloseTo(keys[2]!.x);
    const near = followPath([...every(0, 3, () => 0.5), ...every(3.1, 6, () => 0.52).map((s, i) => (i ? s : { ...s, jump: true }))], 0.32);
    expect(near).toHaveLength(1);
  });

  it("makes a cut right after a cut one cut, to where it ends up: no flash of a face", () => {
    const targets = [...every(0, 3, () => 0.5), ...every(3.1, 3.4, () => 0.2), ...every(3.5, 6, () => 0.8)].map((s) => (s.t === 3.1 || s.t === 3.5 ? { ...s, jump: true } : s));
    const keys = followPath(targets, 0.32);
    expect(keys.map((k) => k.t)).toEqual([0, 3.1, 3.1]);
    expect(keys.at(-1)!.x).toBeCloseTo((0.8 - 0.16) / 0.68, 3);
  });

  it("keeps the window inside the picture at its edges", () => {
    const keys = followPath(every(0, 4, () => 0.02), 0.32);
    expect(keys).toEqual([{ t: 0, x: 0 }]);
    expect(followPath(every(0, 4, () => 0.99), 0.32)).toEqual([{ t: 0, x: 1 }]);
  });

  it("gives an item its own stretch of the path, timed from its start", () => {
    const keys = [{ t: 0, x: 0.2 }, { t: 5, x: 0.2 }, { t: 5, x: 0.8 }];
    expect(pathIn(keys, 1, 2)).toEqual([{ t: 0, x: 0.2 }]);
    expect(pathIn(keys, 4, 2)).toEqual([{ t: 0, x: 0.2 }, { t: 1, x: 0.2 }, { t: 1, x: 0.8 }, { t: 2, x: 0.8 }]);
  });

  it("frames the speaker whose turn it is, two who fit side by side together, and holds a face missed for a moment", () => {
    const left = { x: 0.15, w: 0.1, id: 1 };
    const right = { x: 0.7, w: 0.1, id: 2 };
    const frames = [0, 0.1, 0.2, 2, 2.1].map((t) => ({ t, faces: t === 0.1 ? [right] : [left, right] }));
    const turns = [{ s: 0, e: 1.5, speaker: 1 }, { s: 2, e: 3.5, speaker: 2 }];
    const out = speakerTargets(frames, turns, { 1: [1], 2: [2] }, 0.32);
    expect(out.map((o) => o.c)).toEqual([0.2, 0.2, 0.2, 0.75, 0.75]);
    expect(out.map((o) => !!o.jump)).toEqual([false, false, false, true, false]);
    // close together: one window over both, never a cut between them
    const near = speakerTargets(frames.map((f) => ({ ...f, faces: [{ ...left, x: 0.4 }, { ...right, x: 0.52 }] })), turns, { 1: [1], 2: [2] }, 0.32);
    expect(new Set(near.map((o) => o.c))).toEqual(new Set([0.51]));
  });

  it("does not cut to a turn too short to hold (a 'yes' from the one listening)", () => {
    const frames = Array.from({ length: 60 }, (_, i) => ({ t: i / 10, faces: [{ x: 0.15, w: 0.1, id: 1 }, { x: 0.7, w: 0.1, id: 2 }] }));
    const turns = [{ s: 0, e: 2.5, speaker: 1 }, { s: 2.7, e: 3.1, speaker: 2 }, { s: 3.3, e: 6, speaker: 1 }];
    expect(speakerTargets(frames, turns, { 1: [1], 2: [2] }, 0.32).every((o) => o.c === 0.2 && !o.jump)).toBe(true);
  });
});

describe("a reframed moment on the timeline", () => {
  const wide = { ...src(1920, 1080), versionId: "s", fps: 25 };
  const tl = {
    name: "m1", fps: 25, width: 1080, height: 1920, sources: { s: wide }, markers: [],
    tracks: {
      V1: { name: "V1", items: [{ src: "s", in: 250, len: 100, rec: 0, link: "a", zoom: 1.2, tilt: 30 }, { src: "s", in: 500, len: 100, rec: 100, link: "b" }] },
      V2: { name: "V2", items: [] }, A1: { name: "A1", items: [] }, A2: { name: "A2", items: [] }, A3: { name: "A3", items: [] },
    },
  };

  it("fills the frame on every speaker shot, each with its own stretch of the path, and puts who talks on the timeline's frames", () => {
    const keys = [{ t: 0, x: 0.2 }, { t: 21, x: 0.2 }, { t: 21, x: 0.8 }];
    const turns = [{ s: 10, e: 20.9, speaker: 1 }, { s: 21, e: 24, speaker: 2 }];
    const out = reframeTimeline(tl, { s: { keys, turns } });
    const [a, b] = out.tracks.V1.items;
    expect(a).toEqual({ src: "s", in: 250, len: 100, rec: 0, link: "a", zoom: Math.round(fillZoom(wide, 1080, 1920) * 1e4) / 1e4, path: [{ t: 0, x: 0.2 }] });
    expect(b!.path).toEqual([{ t: 0, x: 0.2 }, { t: 1, x: 0.2 }, { t: 1, x: 0.8 }, { t: 4, x: 0.8 }]);
    expect(out.speakers).toEqual([{ rec: 0, len: 122, speaker: 1 }, { rec: 125, len: 75, speaker: 2 }]);
    // nobody found: the middle, filled
    expect(reframeTimeline(tl, {}).tracks.V1.items.map((i) => i.path)).toEqual([undefined, undefined]);
  });

  it("keeps every source's paths on the timeline, so Review can follow someone else", () => {
    const keys = [{ t: 0, x: 0.2 }];
    const out = reframeTimeline(tl, { s: { keys, speakers: { 1: [{ t: 0, x: 0.1 }], 2: [{ t: 0, x: 0.9 }] } } });
    expect(out.reframe).toEqual({ s: { auto: keys, speakers: { 1: [{ t: 0, x: 0.1 }], 2: [{ t: 0, x: 0.9 }] } } });
  });

  it("follows one person alone: held while they are not seen, a cut when their face is on a new track", () => {
    const fr = (t: number, faces: { x: number; id: number }[]) => ({ t, faces: faces.map((f) => ({ ...f, w: 0.05 })) });
    const frames = [
      ...Array.from({ length: 20 }, (_, i) => fr(i / 10, [{ x: 0.1, id: 1 }, { x: 0.8, id: 2 }])),
      ...Array.from({ length: 10 }, (_, i) => fr(2 + i / 10, [{ x: 0.5, id: 3 }])), // a close-up of someone else
      ...Array.from({ length: 20 }, (_, i) => fr(3 + i / 10, [{ x: 0.7, id: 4 }])), // speaker 1 again, after a cut
    ];
    const keys = speakerPath(frames, [1, 4], 0.3);
    expect(pathAt(keys, 1)).toBeCloseTo(0, 3);
    expect(pathAt(keys, 2.5)).toBeCloseTo(0, 3); // not seen: held
    expect(keys.filter((k, i) => i && keys[i - 1]!.t === k.t)).toHaveLength(1); // one cut, at 3 s
    expect(pathAt(keys, 3)).toBeGreaterThan(0.7);
  });

  it("keys a moving window for an editor that eases in straight lines: a hold is its ends, an ease a key where it bends, a cut two frames", () => {
    const s = src(1920, 1080);
    const zoom = fillZoom(s, 1080, 1920);
    const room = fitted(s, 1080, 1920).w * zoom - 1080;
    const item = { len: 100, zoom, path: [{ t: 0, x: 0.5 }, { t: 1, x: 0.5 }, { t: 2, x: 1 }, { t: 3, x: 1 }, { t: 3, x: 0 }] };
    const keys = panKeys(item, s, 1080, 1920, 25);
    expect(keys[0]).toEqual({ f: 0, pan: 0 });
    expect(keys.find((k) => k.f === 25)).toEqual({ f: 25, pan: 0 });
    expect(keys.slice(-3).map((k) => k.f)).toEqual([74, 75, 99]);
    // every frame between keys within half a pixel of the line through them
    for (let f = 0; f < 100; f++) {
      const [a, b] = [keys.filter((k) => k.f <= f).at(-1)!, keys.find((k) => k.f >= f)!];
      const line = b.f === a.f ? a.pan : a.pan + ((b.pan - a.pan) * (f - a.f)) / (b.f - a.f);
      expect(Math.abs(line - room * (0.5 - pathAt(item.path, f / 25)))).toBeLessThanOrEqual(0.51);
    }
    expect(panKeys({ len: 50, zoom, path: [{ t: 0, x: 0.5 }] }, s, 1080, 1920, 25)).toEqual([]);
    const held = Math.round(room * 0.3 * 100) / 100;
    expect(panKeys({ len: 50, zoom, path: [{ t: 0, x: 0.2 }] }, s, 1080, 1920, 25)).toEqual([{ f: 0, pan: held }]);
  });

  it("looks at a moment's own sentences, only when a shape is asked for", () => {
    const sentences = [{ n: 1, src: "s", s: 1.234, e: 5, text: "", w0: 0, w1: 3 }, { n: 2, src: "s", s: 5.5, e: 9.876, text: "", w0: 4, w1: 9 }];
    const version = { name: "m1", title: "", lines: [{ line: "M1", take: { first: 1, last: 2, score: 1 } }] };
    expect(reframeSpan({ moments: 3, shape: "9:16" }, version, sentences)).toEqual({ src: "s", a: 1.23, b: 9.88 });
    expect(reframeSpan({ moments: 3 }, version, sentences)).toBeNull();
    expect(reframeSpan({ shape: "1:1" }, version, sentences)).toBeNull();
  });

  it("renders the path as ffmpeg's crop x: held, eased, cut, from the piece's own start", () => {
    const e = pathExpr([{ t: 0, x: 0.2 }, { t: 2, x: 0.2 }, { t: 3, x: 0.6 }, { t: 3, x: 0.9 }], 1.5);
    // the same values pathAt gives, read back by evaluating the expression with ffmpeg's functions
    const run = (t: number) => {
      const js = e.replace(/\\,/g, ",").replace(/if\(/g, "iff(").replace(/lt\(/g, "lt(").replace(/clip\(/g, "clip(");
      return new Function("t", "iff", "lt", "clip", `return ${js};`)(t, (c: boolean, a: number, b: number) => (c ? a : b), (a: number, b: number) => a < b, (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)));
    };
    const keys = [{ t: 0, x: 0.2 }, { t: 2, x: 0.2 }, { t: 3, x: 0.6 }, { t: 3, x: 0.9 }];
    for (const t of [0, 0.4, 0.9, 1.2, 1.4, 1.6, 2]) expect(run(t)).toBeCloseTo(pathAt(keys, t + 1.5), 4);
    expect(e).not.toMatch(/[^\\],/);
  });
});
