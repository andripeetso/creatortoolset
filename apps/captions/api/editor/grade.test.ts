import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { applyCdl, cdlFilter, cdlMeta, type Cdl } from "./grade";
import { emptyTracks } from "./timeline";
import { toOtio } from "./otio";
import { shotFilter } from "./preview";

const warm: Cdl = { slope: [1.2, 1, 0.8], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 };
const grey: Cdl = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 0 };
const neutral: Cdl = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 };

/** The filter run on one flat grey frame (128 on every channel); returns its RGB. */
function graded(filter: string): [number, number, number] {
  const out = execFileSync(ffmpegCommand(), [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=16x16:d=0.1",
    "-frames:v", "1", "-vf", filter, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  return [out[0]!, out[1]!, out[2]!];
}

describe("CDL maths", () => {
  it("a neutral grade or none adds no filter", () => {
    expect(cdlFilter(undefined)).toBe("");
    expect(cdlFilter(neutral)).toBe("");
  });

  it("slope scales a channel, saturation 0 greys it, the power bends the mids", () => {
    expect(applyCdl(warm, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.6, 6);
    expect(applyCdl(warm, [0.5, 0.5, 0.5])[2]).toBeCloseTo(0.4, 6);
    const [r, g, b] = applyCdl(grey, [0.9, 0.2, 0.2]);
    expect(r).toBeCloseTo(g, 6);
    expect(g).toBeCloseTo(b, 6);
    expect(applyCdl({ ...neutral, power: [2, 2, 2] }, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.25, 6);
  });

  it("the ffmpeg filter changes the preview colour the way the CDL does", () => {
    const [r, g, b] = graded(cdlFilter(warm));
    expect(r).toBeGreaterThan(140);
    expect(b).toBeLessThan(110);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(3);
    const [rg, gg, bg] = graded(cdlFilter(grey));
    // saturation 0 greys it; the 8-bit YUV round trip leaves a few levels of tint
    expect(Math.abs(rg - gg)).toBeLessThanOrEqual(4);
    expect(Math.abs(gg - bg)).toBeLessThanOrEqual(4);
  });

  it("shotFilter adds the grade before the final pixel format, and leaves an ungraded shot as it was", () => {
    const tl: Timeline = {
      name: "t", fps: 30, width: 360, height: 640,
      sources: { a: { versionId: "a", name: "A", fps: 30, tc: 0, dur: 90, w: 360, h: 640 } },
      tracks: emptyTracks(), markers: [],
    };
    const item = { src: "a", in: 0, len: 10, rec: 0 };
    const plain = shotFilter(tl, item);
    expect(shotFilter(tl, item, neutral)).toBe(plain);
    expect(shotFilter(tl, item, warm)).toBe(plain.replace(",format=yuv420p", `,${cdlFilter(warm)},format=yuv420p`));
  });
});

describe("OTIO carries the grade", () => {
  const tl: Timeline = {
    name: "Tiny Acrobatics v1", fps: 30, width: 360, height: 640,
    sources: { a: { versionId: "a", name: "Take", fps: 30, tc: 0, dur: 90, w: 360, h: 640 } },
    tracks: emptyTracks(), markers: [],
  };
  tl.tracks.V1.items = [{ src: "a", in: 0, len: 10, rec: 0 }];
  tl.tracks.A1.items = [{ src: "a", in: 0, len: 10, rec: 0 }];
  const files = { a: "/media/take.mov" };
  type Clip = { metadata: { Resolve_OTIO: Record<string, unknown> } };
  const clips = (otio: object, track: number) =>
    (otio as { tracks: { children: { children: Clip[] }[] } }).tracks.children[track]!.children[0]!;

  it("no grade: no CDL key on any clip", () => {
    const otio = toOtio(tl, files);
    expect(JSON.stringify(otio)).not.toContain('"CDL"');
  });

  it("a grade goes on the V1 clip in Resolve's SetCDL form and not on the audio clip", () => {
    const otio = toOtio(tl, files, warm);
    expect(clips(otio, 0).metadata.Resolve_OTIO.CDL).toEqual(cdlMeta(warm));
    expect(cdlMeta(warm)).toEqual({ NodeIndex: "1", Slope: "1.200000 1.000000 0.800000", Offset: "0.000000 0.000000 0.000000", Power: "1.000000 1.000000 1.000000", Saturation: "1.000000" });
    expect(clips(otio, 2).metadata.Resolve_OTIO.CDL).toBeUndefined();
  });
});
