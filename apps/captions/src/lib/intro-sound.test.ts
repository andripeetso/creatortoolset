import { describe, expect, it } from "vitest";
import { BEATS } from "@/components/HomeIntro";
import { hitsFor, step } from "./intro-sound";

const n = { stages: 3, tiles: 6, extras: 7, chips: 4 };

describe("the welcome's sound", () => {
  it("has one note for each thing that pops in", () => {
    const notes = (beat: (typeof BEATS)[number]["id"], counts = n) => hitsFor(beat, counts).filter((h) => h.kind === "note").length;
    expect(notes("hello")).toBe("CreatorToolset".length);
    expect(notes("stages")).toBe(3);
    expect(notes("tools")).toBe(6 + 7);
    expect(notes("tools", { stages: 3, tiles: 4, extras: 2, chips: 0 })).toBe(6);
    // a Home with one box switched off: two stages pop up, two boxes open
    expect(notes("stages", { ...n, stages: 2 })).toBe(2);
    expect(hitsFor("tools", { ...n, stages: 2 }).filter((h) => h.kind === "thud")).toHaveLength(2);
    expect(notes("connect")).toBe(4);
    expect(hitsFor("tools", n).filter((h) => h.kind === "thud")).toHaveLength(3); // a box opening, three boxes
  });

  it("starts every sound inside its own beat, so a shorter beat never leaves a sound for the next", () => {
    for (const b of BEATS) for (const h of hitsFor(b.id, n)) expect(h.at).toBeLessThan(b.ms / 1000);
  });

  it("climbs: each run of notes goes up the scale", () => {
    expect(step(0)).toBeCloseTo(293.66);
    expect(step(5)).toBeCloseTo(587.32);
    expect(step(-5)).toBeCloseTo(146.83);
    // nothing bright: no note is written above D5 except the quick run over the Extras
    for (const b of BEATS) for (const h of hitsFor(b.id, { ...n, extras: 0 })) for (const hz of h.kind === "note" ? [h.hz] : h.kind === "bell" ? h.hz : []) expect(hz).toBeLessThan(1000);
    for (const beat of ["hello", "tools", "connect"] as const) {
      const hz = hitsFor(beat, n).flatMap((h) => (h.kind === "note" ? [h.hz] : []));
      const tiles = beat === "tools" ? hz.slice(0, n.tiles) : hz;
      expect([...tiles].sort((a, b) => a - b)).toEqual(tiles);
    }
  });
});
