import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-subject-"));
process.env.DATA_DIR = dir;
const { centreOn, fillZoom, followPath, pickKey, windowOf } = await import("./framing");
const { faceless, followPicked, seedShots, subjectFile, subjectTargets } = await import("./subject");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the subject tracker's seeds", () => {
  it("seeds each shot on its own: a click in it, else the description over its middle, else nothing", () => {
    const seeds = [
      { a: 10, b: 15, text: "a penguin sliding downhill" },
      { a: 15, b: 30, text: "a red kart" },
      { t: 21.2, x: 0.7, y: 0.4 },
    ];
    // cuts at 14 and 20; one at 25 outside the stretch is not this stretch's
    expect(seedShots([20, 14, 25], 10, 24, seeds)).toEqual([
      { s: 10, e: 14, seed: { t: 10.5, text: "a penguin sliding downhill" } },
      // its middle (17) is in the second description
      { s: 14, e: 20, seed: { t: 14.5, text: "a red kart" } },
      { s: 20, e: 24, seed: { t: 21.2, x: 0.7, y: 0.4 } },
    ]);
    // no description and no click: not followed; a shot shorter than a looked-at frame is left out
    expect(seedShots([12, 12.05], 10, 14, [])).toEqual([
      { s: 10, e: 12, seed: null },
      { s: 12.05, e: 14, seed: null },
    ]);
    // a short shot is looked at a quarter in, not past its end
    expect(seedShots([], 0, 1, [{ a: 0, b: 1, text: "a ball" }])[0]!.seed).toEqual({ t: 0.25, text: "a ball" });
  });

  it("a stretch with faces in fewer than a fifth of its frames has its subject followed", () => {
    const frames = (withFace: number, of: number) => Array.from({ length: of }, (_, i) => ({ faces: i < withFace ? [{}] : [] }));
    expect(faceless(frames(1, 10))).toBe(true);
    expect(faceless(frames(2, 10))).toBe(false);
  });
});

describe("the followed subject's window", () => {
  it("moves like the speaker's: the box's middle, a cut at a new shot, frames it is not seen in held", () => {
    const tracked = {
      shots: [0, 2],
      frames: [
        { t: 0, box: [0.1, 0.4, 0.1, 0.2] as [number, number, number, number] },
        { t: 0.1, box: null },
        { t: 1.9, box: [0.15, 0.4, 0.1, 0.2] as [number, number, number, number] },
        { t: 2, box: [0.7, 0.4, 0.2, 0.2] as [number, number, number, number] },
      ],
    };
    expect(subjectTargets(tracked)).toEqual([
      { t: 0, c: 0.15 },
      { t: 1.9, c: 0.2 },
      { t: 2, c: 0.8, jump: true },
    ]);
    // a 9:16 window (0.32 of the picture) holds over the small move and cuts at the new shot
    expect(followPath(subjectTargets(tracked), 0.32)).toEqual([
      { t: 0, x: 0 },
      { t: 2, x: 0 },
      { t: 2, x: centreOn(0.8, 0.32) },
    ]);
  });
});

describe("a subject clicked in Review", () => {
  const click = { t: 10.5, x: 0.8, y: 0.5 };
  const src = { versionId: "A", name: "A", tc: 0, w: 1920, h: 1080, fps: 25, dur: 1500 };
  const zoom = fillZoom(src, 1080, 1920);
  const win = windowOf(src, 1080, 1920, zoom);
  // two pieces of one shot set to follow the click: 10-12 s and 12-13 s of the source
  const tl = () =>
    ({
      name: "t",
      fps: 25,
      width: 1080,
      height: 1920,
      sources: { A: src },
      tracks: {
        V1: { items: [{ src: "A", in: 250, len: 50, rec: 0, zoom, crop: { subject: click }, path: [{ t: 0, x: centreOn(0.8, win) }] }, { src: "A", in: 300, len: 25, rec: 50, zoom, crop: { subject: click } }] },
        V2: { items: [] }, A1: { items: [] }, A2: { items: [] }, A3: { items: [] },
      },
    }) as unknown as Timeline;

  it("is held on the click where nothing can follow it, and nothing is asked of a draft without one", async () => {
    expect(await followPicked(tl(), { A: "/nowhere.mp4" }, new AbortController().signal)).toBe("held");
    const none = tl();
    for (const i of none.tracks.V1.items) delete i.crop;
    expect(await followPicked(none, { A: "/nowhere.mp4" }, new AbortController().signal)).toBeNull();
  });

  it("is followed through the camera shot it was clicked in, on every piece set to it; the other shots keep their frame; the path is kept for the next versions", async () => {
    // what the tracker found: on the right in the clicked shot, then (a new shot at 11.5 s) something on the left
    const frames = Array.from({ length: 30 }, (_, i) => {
      const t = Math.round((10 + i / 10) * 1000) / 1000;
      return { t, box: (t < 11.5 ? [0.75, 0.4, 0.1, 0.2] : [0.25, 0.4, 0.1, 0.2]) as [number, number, number, number] };
    });
    const file = subjectFile("A", 10, 13, [click]);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ frames, shots: [10, 11.5] }));
    const got = await followPicked(tl(), { A: "/nowhere.mp4" }, new AbortController().signal);
    if (!got || got === "held") throw new Error("not followed");
    const right = centreOn(0.8, win);
    // followed until the shot ends at 11.5 s, then back to the middle (this source has no path of its own)
    expect(got.tracks.V1.items[0]!.path).toEqual([{ t: 0, x: right }, { t: 1.5, x: right }, { t: 1.5, x: 0.5 }, { t: 2, x: 0.5 }]);
    expect(got.tracks.V1.items[1]!.path).toEqual([{ t: 0, x: 0.5 }]);
    expect(got.reframe!.A!.picked![pickKey(click)]).toEqual([{ t: 10, x: 0.5 }, { t: 10, x: right }, { t: 11.5, x: right }, { t: 11.5, x: 0.5 }]);
    // followed once: the next preview has nothing left to follow
    expect(await followPicked(got, { A: "/nowhere.mp4" }, new AbortController().signal)).toBeNull();
  });
});
