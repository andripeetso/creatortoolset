import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EdjTrans } from "@contracts/editor";
import { handlesAt, maxLen, setTrack, withKeys, type NleTimeline } from "./model";
import { addTransition, normalizeTrans, removeTransition, setTransition } from "./trans";

const GOLDEN = JSON.parse(readFileSync(new URL("../../../contracts/edj-golden.json", import.meta.url), "utf8")) as {
  handles: { at: EdjTrans["at"]; len: number; fps: number; earlier: { speed: number; sfps: number }; later: { speed: number; sfps: number }; tail: number; head: number }[];
};

// Two Tiny Acrobatics shots cut together on V1 with their voice on A1: the first has 10 frames of its source left after
// it, the second 3 before it.
const pair = (more: Partial<NleTimeline> = {}): NleTimeline =>
  withKeys({
    timeline: { fps: 25 },
    sources: { cam: { fps: 25, dur: 160 } },
    tracks: {
      V1: { items: [{ src: "cam", rec: 0, len: 50, in: 100, link: 1 }, { src: "cam", rec: 50, len: 50, in: 3, link: 2 }] },
      A1: { items: [{ src: "cam", rec: 0, len: 50, in: 100, link: 1 }, { src: "cam", rec: 50, len: 50, in: 3, link: 2 }] },
    },
    ...more,
  });
const later = (tl: NleTimeline, track = "V1") => tl.tracks[track].items[1];

describe("transitions", () => {
  it("finds the room at a cut and the longest transition each alignment takes", () => {
    const tl = pair();
    const h = handlesAt(tl, later(tl)._k!)!;
    expect(h).toEqual({ pre: 3, post: 10 });
    expect(handlesAt(tl, tl.tracks.V1.items[0]._k!)).toBeNull();
    // centred: floor(len / 2) before the cut needs 3, the rest after it 10
    expect([maxLen(h, "center"), maxLen(h, "start"), maxLen(h, "end")]).toEqual([7, 10, 3]);
  });

  it("matches the golden handles: a clip has room when its handle is at least the product, not a frame less", () => {
    for (const c of GOLDEN.handles) {
      // a hundredth of a source frame short on the side the alignment needs (the head, unless it starts at the cut)
      for (const short of [0, 0.01]) {
        const [tail, head] = c.at === "start" ? [c.tail - short, c.head] : [c.tail, c.head - short];
        const tl = withKeys({
          timeline: { fps: c.fps },
          sources: { a: { fps: c.earlier.sfps, dur: (100 * c.earlier.speed * c.earlier.sfps) / c.fps + tail }, b: { fps: c.later.sfps } },
          tracks: { V1: { items: [{ src: "a", rec: 0, len: 100, in: 0, speed: c.earlier.speed }, { src: "b", rec: 100, len: 100, in: head, speed: c.later.speed }] } },
        });
        expect(maxLen(handlesAt(tl, later(tl)._k!)!, c.at) >= c.len, `${c.at} ${c.len} short ${short}`).toBe(!short);
      }
    }
  });

  it("adds Resolve's 1 s cross dissolve kept to its handles, a crossfade on the linked voice", () => {
    const tl = pair();
    const out = addTransition(tl, later(tl)._k!);
    expect(later(out).trans).toEqual({ type: "dissolve", len: 7, at: "center" });
    expect(later(out, "A1").trans).toEqual({ type: "crossfade", len: 7, at: "center" });
    expect(later(addTransition(tl, later(tl)._k!, { type: "dip_black" }, false), "A1").trans).toBeUndefined();
    expect(addTransition(tl, tl.tracks.V1.items[0]._k!)).toBe(tl);
    // no handle at all: nothing to add
    const none = pair();
    none.tracks.V1.items[1].in = 0;
    expect(addTransition(none, later(none)._k!, { at: "end" })).toBe(none);
    // centred, one frame needs no head: it starts at the cut
    expect(later(addTransition(none, later(none)._k!)).trans?.len).toBe(1);
    // a locked voice keeps none
    const locked = setTrack(tl, "A1", { locked: true });
    expect(later(addTransition(locked, later(locked)._k!), "A1").trans).toBeUndefined();
    expect(addTransition(setTrack(tl, "V1", { locked: true }), later(tl)._k!).tracks.V1.items[1].trans).toBeUndefined();
  });

  it("changes length and alignment on both, the type on the one picked; removes both", () => {
    const start = pair();
    let tl = addTransition(start, later(start)._k!);
    tl = setTransition(tl, later(tl)._k!, { type: "dip_white", at: "start", len: 30 });
    expect(later(tl).trans).toEqual({ type: "dip_white", len: 10, at: "start" });
    expect(later(tl, "A1").trans).toEqual({ type: "crossfade", len: 10, at: "start" });
    tl = removeTransition(tl, later(tl)._k!);
    expect(later(tl).trans).toBeUndefined();
    expect(later(tl, "A1").trans).toBeUndefined();
  });

  it("normalizeTrans drops a transition with no cut under it and clamps one past its handles; a fine timeline comes back as it is", () => {
    const saved = (): NleTimeline => ({
      timeline: { fps: 25 },
      sources: { cam: { fps: 25, dur: 160 } },
      tracks: {
        V1: { items: [{ src: "cam", rec: 0, len: 50, in: 100 }, { src: "cam", rec: 50, len: 50, in: 3, trans: { type: "dissolve", len: 20, at: "center" } }] },
        V2: { items: [{ src: "cam", rec: 10, len: 20, in: 0 }, { src: "cam", rec: 40, len: 20, in: 50, trans: { type: "dissolve", len: 4, at: "end" } }] },
      },
    });
    const out = normalizeTrans(saved());
    expect(out.tracks.V1.items[1].trans).toEqual({ type: "dissolve", len: 7, at: "center" });
    expect(out.tracks.V2.items[1].trans).toBeUndefined();
    expect(normalizeTrans(out)).toBe(out);
  });

  it("a retouched or censored copy has room only as far as the frames it was made with (its own dur)", () => {
    // made from frames 75-200 of `cam` (HANDLE 25 either side of 100-175), the cut using 100-175 of it
    const tl = pair({
      sources: { cam: { fps: 25, dur: 1000 }, camr75: { fps: 25, dur: 125, retouched: { from: "cam", at: 75 } } },
    });
    tl.tracks.V1.items[1] = { ...tl.tracks.V1.items[1], src: "camr75", in: 25, len: 75 };
    expect(handlesAt(tl, later(tl)._k!)).toEqual({ pre: 25, post: 75 });
  });
});
