import { describe, expect, it } from "vitest";
import type { NleTimeline } from "@/lib/nle/model";
import { poolRows, sortRows } from "./NleMediaPool";

const tl: NleTimeline = {
  timeline: { fps: 25 },
  sources: {
    a: { path: "/clips/Tiny Acrobatics flip.mp4", dur: 250, w: 1080, h: 1920 },
    b: { path: "/clips/bounce.mp4", fps: 50, dur: 100, w: 3840, h: 2160 },
    m: { path: "/music/song.m4a", dur: 5000 },
  },
  tracks: {
    V1: { items: [{ src: "a", rec: 0, len: 10, in: 0 }, { src: "b", rec: 10, len: 10, in: 0 }, { src: "a", rec: 20, len: 10, in: 0 }] },
    A1: { items: [{ src: "a", rec: 0, len: 10, in: 0 }] },
    A2: { items: [{ src: "m", rec: 0, len: 30, in: 0 }] },
  },
};
const nameOf = (src: string) => String(tl.sources[src].path).split("/").pop()!;

describe("media pool rows", () => {
  const rows = poolRows(tl, nameOf);

  it("lists each source once, with its uses and whether it is on a video track", () => {
    const by = Object.fromEntries(rows.map((r) => [r.src, r]));
    expect(by.a).toMatchObject({ uses: 3, video: true, fps: 25, frames: 250 });
    expect(by.b).toMatchObject({ uses: 1, video: true, fps: 50 });
    expect(by.m).toMatchObject({ uses: 1, video: false });
  });

  it("sorts by a column either way, unknown values first going up", () => {
    const order = (key: Parameters<typeof sortRows>[1]["key"], up: boolean) => sortRows(rows, { key, up }).map((r) => r.src);
    expect(order("name", true)).toEqual(["b", "m", "a"]);
    expect(order("uses", false)).toEqual(["a", "b", "m"]); // b and m tie on uses: by name
    expect(order("dur", true)).toEqual(["b", "a", "m"]); // 2 s, 10 s, 200 s
    expect(order("res", true)).toEqual(["m", "a", "b"]);
    expect(order("res", false)).toEqual(["b", "a", "m"]);
  });
});
