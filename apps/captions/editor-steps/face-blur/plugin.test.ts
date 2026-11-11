import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { venvDir } from "../../api/editor/mediapipe";
import { ffmpeg } from "../../api/library/media/run";
import { type Box, blurFaces, blurRanges, buildTracks, chosenIn, copyKey, ellipseOf, ellipses, pickFrames, trackBoxes } from "./plugin";

const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "face-blur-"));
const tl = (v1: object[], v2: object[] = [], sources: object = { t: { fps: 25, dur: 1000, w: 1080, h: 1920 }, b: { fps: 25, dur: 500, w: 1080, h: 1920 } }) =>
  ({ fps: 25, sources, tracks: { V1: { items: v1 }, V2: { items: v2 }, A1: { items: [] } } }) as unknown as Timeline;
const box = (x: number, y = 100, w = 100): Box => [x, y, w, w, 0.9];
const input = (timeline: Timeline, files: Record<string, string>, values: Record<string, string> = {}, notes: string[] = []) => ({
  edit: { id: "e", name: "E", createdBy: "nobody-here" }, variant: "", files, timeline, values, workDir: dir, signal: new AbortController().signal, note: (t: string) => notes.push(t),
});

describe("which frames Blur faces looks at", () => {
  it("takes what V1 shows where B-roll doesn't cover it, and the B-roll itself, 25 frames either side", () => {
    expect(blurRanges(tl([{ src: "t", in: 0, len: 400, rec: 0 }], [{ src: "b", in: 100, rec: 100, len: 200 }]))).toEqual({ t: [[0, 125], [275, 425]], b: [[75, 325]] });
    expect(blurRanges(tl([{ src: "t", in: 10, len: 50, rec: 0 }, { src: "t", in: 960, len: 30, rec: 50 }]))).toEqual({ t: [[0, 85], [935, 1000]] });
  });

  it("skips sound-only sources", () => {
    expect(blurRanges(tl([{ src: "a", in: 0, len: 50, rec: 0 }], [], { a: { fps: 25, dur: 100, w: 0, h: 0 } }))).toEqual({});
  });
});

describe("face tracks", () => {
  it("follows each face from frame to frame, through short gaps, and drops flickers", () => {
    const dets: Record<string, Box[]> = {};
    for (let f = 0; f < 40; f += 2) dets[f] = [box(100 + f), box(800 - f, 1500, 60)];
    dets[10] = [box(790, 1500, 60)];
    dets[12] = [box(788, 1500, 60)]; // the first face missed for a moment
    dets[30]!.push(box(500, 900)); // seen once: a flicker
    const tracks = buildTracks("t", dets);
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.boxes.size)).toEqual([18, 20]);
    expect(tracks[0]!.boxes.get(38)![0]).toBe(138);
  });

  it("keeps two faces apart, and a face seen once is no track", () => {
    const dets: Record<string, Box[]> = { 0: [box(0), box(1000)], 2: [box(20), box(980)], 4: [box(40), box(960)], 6: [box(60), box(940), box(500, 1500)] };
    expect(buildTracks("t", dets).map((t) => [...t.boxes.keys()])).toEqual([[0, 2, 4, 6], [0, 2, 4, 6]]);
  });

  it("fills the gaps in a straight line and holds before and after, inside the file", () => {
    const boxes = trackBoxes({ boxes: new Map([[10, box(100)], [20, box(200)], [30, box(300)]]) }, 34);
    expect([...boxes.keys()][0]).toBe(4);
    expect([...boxes.keys()].at(-1)).toBe(33);
    expect(boxes.get(15)![0]).toBeCloseTo(150, 0);
    expect(boxes.get(4)![0]).toBe(100);
  });

  it("covers the face box whole with the ellipse, a little up for the forehead", () => {
    const [cx, cy, rx, ry] = ellipseOf([100, 200, 100, 100, 1]);
    expect([cx, cy]).toEqual([150, 245]);
    // every corner of the box's inner face (a box's corners are background) is inside: (x/rx)² + (y/ry)² ≤ 1 at 80% of the box
    for (const [x, y] of [[110, 210], [190, 210], [110, 290], [190, 290]]) expect(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2).toBeLessThanOrEqual(1);
    expect(Object.keys(ellipses([{ boxes: new Map([[0, box(0)], [2, box(0)], [4, box(0)]]) }], 100))).toHaveLength(11);
  });

  it("picks the clearest picture of each third of a track", () => {
    const boxes = new Map<number, Box>(Array.from({ length: 30 }, (_, i) => [i, [0, 0, i === 4 || i === 15 || i === 29 ? 200 : 100, 100, 0.9] as Box]));
    expect(pickFrames({ boxes })).toEqual([4, 15, 29]);
  });
});

describe("the AI's answer", () => {
  it("takes the track ids it names, of those asked about, also inside other words", () => {
    expect([...chosenIn('Sure: {"blur": ["T2", "T7", "T4"]}', ["T1", "T2", "T4"])]).toEqual(["T2", "T4"]);
    expect(chosenIn('{"blur": []}', ["T1"]).size).toBe(0);
    expect(() => chosenIn("I can't tell", ["T1"])).toThrow(/no JSON/);
  });
});

describe("the copy's key", () => {
  it("changes with the file, the frames, the instruction and the look", () => {
    const f = path.join(dir, "k.mov");
    writeFileSync(f, "x");
    const k = copyKey(f, [[0, 10]], "the people at the back", "blur");
    expect(copyKey(f, [[0, 10]], "the people at the back", "blur")).toBe(k);
    expect(copyKey(f, [[0, 11]], "the people at the back", "blur")).not.toBe(k);
    expect(copyKey(f, [[0, 10]], "everyone", "blur")).not.toBe(k);
    expect(copyKey(f, [[0, 10]], "the people at the back", "pixels")).not.toBe(k);
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(copyKey(f, [[0, 10]], "the people at the back", "blur")).not.toBe(k);
  });
});

describe("Blur faces on a photo", () => {
  it("leaves it alone and says so", async () => {
    const notes: string[] = [];
    const timeline = tl([{ src: "t", in: 0, len: 50, rec: 0 }], [], { t: { name: "Group photo", fps: 25, dur: 50, w: 1080, h: 1920 } });
    expect(await blurFaces(input(timeline, { t: path.join(dir, "group.jpg") }, {}, notes))).toEqual({});
    expect(notes).toEqual(["Blur faces left the photos as they are: Group photo"]);
  });
});

describe("Blur faces without an AI", () => {
  it("says what to connect, before it sets anything up", async () => {
    const f = path.join(dir, "take.mov");
    writeFileSync(f, "x");
    await expect(blurFaces(input(tl([{ src: "t", in: 0, len: 50, rec: 0 }]), { t: f }))).rejects.toThrow("Blur faces needs your AI to decide which faces match: connect one in Settings → Providers");
  });
});

// The engine runs only where the face steps' Python is set up already (a step's first run does it: a few hundred MB).
describe.skipIf(!existsSync(path.join(venvDir(), "ready")))("the Blur faces engine", () => {
  it("says so when there is no face, and leaves the file alone", async () => {
    const take = path.join(dir, "noface.mov");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=25:duration=2", "-c:v", "mpeg4", "-timecode", "01:00:10:00", take]);
    const notes: string[] = [];
    const timeline = tl([{ src: "t", in: 0, len: 50, rec: 0 }], [], { t: { fps: 25, dur: 50, w: 320, h: 568 } });
    expect(await blurFaces(input(timeline, { t: take }, {}, notes), async () => '{"blur": []}')).toEqual({});
    expect(notes).toEqual(["Blur faces found no face in the footage"]);
    expect(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream_tags=timecode", "-of", "csv=p=0", take], { encoding: "utf8" })).toContain("01:00:10:00");
  }, 120_000);
});
