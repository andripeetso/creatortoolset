import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { env } from "../../api/lib/env";
import { ffmpeg } from "../../api/library/media/run";
import { copyKey, faceRanges, refineFaces } from "./plugin";

const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "face-step-"));
const tl = (v1: object[], v2: object[] = [], sources: object = { t: { fps: 25, dur: 1000, w: 1080, h: 1920 } }) =>
  ({ fps: 25, sources, tracks: { V1: { items: v1 }, V2: { items: v2 }, A1: { items: [] } } }) as unknown as Timeline;

describe("which frames the Face refinement step retouches", () => {
  it("takes what V1 shows, with 25 frames either side, inside the file", () => {
    expect(faceRanges(tl([{ src: "t", in: 100, len: 50, rec: 0 }]))).toEqual({ t: [[75, 175]] });
    expect(faceRanges(tl([{ src: "t", in: 10, len: 50, rec: 0 }, { src: "t", in: 960, len: 30, rec: 50 }]))).toEqual({ t: [[0, 85], [935, 1000]] });
  });

  it("leaves out what B-roll covers, and joins pieces less than 50 frames apart", () => {
    // shown 0-100 and 300-400 of the shot (in 0): two ranges; a 40-frame cutaway leaves pieces 0-200 and 240-400, joined
    expect(faceRanges(tl([{ src: "t", in: 0, len: 400, rec: 0 }], [{ src: "b", rec: 100, len: 200 }]))).toEqual({ t: [[0, 125], [275, 425]] });
    expect(faceRanges(tl([{ src: "t", in: 0, len: 400, rec: 0 }], [{ src: "b", rec: 200, len: 40 }]))).toEqual({ t: [[0, 425]] });
    expect(faceRanges(tl([{ src: "t", in: 0, len: 100, rec: 0 }], [{ src: "b", rec: 0, len: 100 }]))).toEqual({});
  });

  it("counts in the source's own frames and skips sound-only sources", () => {
    const sources = { t: { fps: 50, dur: 10_000, w: 1080, h: 1920 }, a: { fps: 25, dur: 1000, w: 0, h: 0 } };
    expect(faceRanges(tl([{ src: "t", in: 200, len: 50, rec: 0 }, { src: "a", in: 0, len: 50, rec: 50 }], [], sources))).toEqual({ t: [[175, 325]] });
  });

  it("makes a new copy when the file, the frames or the look change", () => {
    const f = path.join(dir, "k.mov");
    writeFileSync(f, "x");
    const k = copyKey(f, [[0, 10]], "medium");
    expect(copyKey(f, [[0, 10]], "medium")).toBe(k);
    expect(copyKey(f, [[0, 11]], "medium")).not.toBe(k);
    expect(copyKey(f, [[0, 10]], "strong")).not.toBe(k);
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(copyKey(f, [[0, 10]], "medium")).not.toBe(k);
  });
});

// The engine runs only where its Python is set up already (the step's first run does it: a few hundred MB).
const ready = existsSync(path.join(env.dataDir, "plugins", "editor-face-refine")) &&
  readdirSync(path.join(env.dataDir, "plugins", "editor-face-refine")).some((d) => existsSync(path.join(env.dataDir, "plugins", "editor-face-refine", d, "ready")));

describe.skipIf(!ready)("the Face refinement engine", () => {
  it("gives a file with no face back as it is", async () => {
    const take = path.join(dir, "noface.mov");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=25:duration=2", "-c:v", "mpeg4", "-timecode", "01:00:10:00", take]);
    const timeline = tl([{ src: "t", in: 0, len: 50, rec: 0 }], [], { t: { fps: 25, dur: 50, w: 320, h: 568 } });
    const input = { edit: { id: "e", name: "E", createdBy: "me" }, variant: "", files: { t: take }, timeline, values: {}, workDir: dir, signal: new AbortController().signal };
    expect(await refineFaces(input)).toEqual({});
    expect(readdirSync(dir).filter((f) => f.endsWith(".noface"))).toHaveLength(1);
    expect(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream_tags=timecode", "-of", "csv=p=0", take], { encoding: "utf8" })).toContain("01:00:10:00");
  }, 120_000);
});
