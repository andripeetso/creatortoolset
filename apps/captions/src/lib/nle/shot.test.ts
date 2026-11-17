import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { NleItem } from "./model";
import { drawnAsShot, shotPlan, shotTime, type Pic } from "./shot";

type Op = { pic: string | number; src: number[]; dst: number[]; bg?: object; edge?: number };
type Fixture = {
  cases: { name: string; timeline: [number, number]; item: NleItem; k: number; sizes: Record<string, [number, number]>; plan: { ops: Op[]; view: number[] } }[];
  paths: { name: string; track: string; item: NleItem; shot: boolean }[];
  times: { name: string; fps: number; item: NleItem; k: number; t: number }[];
};
// the renderer's own answers for shot-list shots (its check renders each one and holds the frame against these)
const fixture = JSON.parse(readFileSync(new URL("./shots.fixture.json", import.meta.url), "utf8")) as Fixture;

describe("nle shot-list shots", () => {
  it("draws every framing as the renderer does", () => {
    for (const c of fixture.cases) {
      const p = shotPlan(c.item, c.k, (pic: Pic) => c.sizes[String(pic)] ?? null, ...c.timeline);
      expect(p.ops.map((o) => [String(o.pic), !!o.bg, !!o.edge]), c.name).toEqual(c.plan.ops.map((o) => [String(o.pic), !!o.bg, !!o.edge]));
      p.ops.forEach((o, i) => {
        const w = c.plan.ops[i];
        o.src.forEach((v, j) => expect(v, `${c.name} op ${i} src ${j}`).toBeCloseTo(w.src[j], 2));
        o.dst.forEach((v, j) => expect(v, `${c.name} op ${i} dst ${j}`).toBeCloseTo(w.dst[j], 2));
        if (w.bg) expect(o.bg, c.name).toEqual(w.bg);
        if (w.edge) expect(o.edge, c.name).toBeCloseTo(w.edge, 3);
      });
      p.view.forEach((v, j) => expect(v, `${c.name} view ${j}`).toBeCloseTo(c.plan.view[j], 2));
    }
    expect(fixture.cases.length).toBeGreaterThan(10);
  });

  it("takes the renderer's way for each clip: a shot, or placed by hand", () => {
    for (const c of fixture.paths) expect(drawnAsShot(c.item, c.track, 1080, 1920), c.name).toBe(c.shot);
  });

  it("shows the source frame the renderer shows: faster, backwards, held", () => {
    for (const c of fixture.times) expect(shotTime(c.item, "main", c.k, c.fps, () => c.fps), c.name).toBeCloseTo(c.t, 6);
  });
});
