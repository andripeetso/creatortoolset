import type { PackGrade } from "../../contracts/packs";

/**
 * A pack's colour grade as maths: an ASC CDL (slope, offset and power per channel, then saturation about Rec.709
 * luma), the form Resolve's node 1 takes. The preview's ffmpeg filter and the OTIO metadata both come from here, so
 * they agree.
 */

export type Cdl = PackGrade["cdl"];

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const neutral = (c: Cdl) => c.slope.every((v) => v === 1) && c.offset.every((v) => v === 0) && c.power.every((v) => v === 1) && c.saturation === 1;

/** One colour (RGB, 0–1) through the grade: slope and offset, the power (negatives go to 0 first), then saturation. */
export function applyCdl(cdl: Cdl, rgb: readonly [number, number, number]): [number, number, number] {
  const x = rgb.map((v, c) => Math.min(1, Math.max(0, v * cdl.slope[c]! + cdl.offset[c]!) ** cdl.power[c]!));
  const y = x[0]! * LUMA[0] + x[1]! * LUMA[1] + x[2]! * LUMA[2];
  return x.map((v) => Math.min(1, Math.max(0, y + cdl.saturation * (v - y)))) as [number, number, number];
}

/**
 * The ffmpeg filter for the grade on 8-bit video, or "" for no grade (or a neutral one). Each channel is one lutrgb
 * expression (slope, offset, power, clipped to 0–255). Saturation is the chroma of the YUV picture scaled by the same
 * factor, which matches the Rec.709 luma form for this picture. ponytail: 8-bit with clipping before saturation, not the
 * float path grade.py uses; add a float pipeline when a grade clips visibly on superwhites.
 */
export function cdlFilter(cdl?: Cdl): string {
  if (!cdl || neutral(cdl)) return "";
  const channel = (c: number) => {
    const o = cdl.offset[c]!;
    return `clip(pow(max(0,val/255*${cdl.slope[c]!.toFixed(6)}${o < 0 ? "" : "+"}${o.toFixed(6)}),${cdl.power[c]!.toFixed(6)})*255,0,255)`;
  };
  const lut = `lutrgb=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}'`;
  return cdl.saturation === 1 ? lut : `${lut},format=yuv420p,eq=saturation=${cdl.saturation.toFixed(6)}`;
}

/** The grade as Resolve's SetCDL takes it (strings), for the OTIO clip metadata. */
export function cdlMeta(cdl: Cdl): Record<string, string> {
  const j = (v: number[]) => v.map((x) => x.toFixed(6)).join(" ");
  return { NodeIndex: "1", Slope: j(cdl.slope), Offset: j(cdl.offset), Power: j(cdl.power), Saturation: cdl.saturation.toFixed(6) };
}
