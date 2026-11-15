import type { GenSpec } from "../../contracts/edit-plan";
import { ffmpeg } from "../library/media/run";

/**
 * A stand-in for the generated clips (generate.ts), built beside the plan step: the same names and shapes, so the plan
 * step moves over by its import alone. Until then a generated clip is a moving colour gradient.
 */

/** The generator's styles. */
export const styles = (): string[] => ["gradient"];

const colour = (c: string | undefined, d: string) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? `0x${c!.slice(1)}` : d);

/** A clip made from nothing: `spec.seconds` of a slowly moving gradient in its palette, `w`x`h` at `fps`, into `out` (.mp4). */
export async function generateClip(spec: GenSpec, out: string, size: { w: number; h: number; fps: number }): Promise<void> {
  const [c0, c1] = [colour(spec.palette?.[0], "0x101820"), colour(spec.palette?.[1], "0xf2aa4c")];
  await ffmpeg([
    "-f", "lavfi", "-i", `gradients=s=${size.w}x${size.h}:r=${size.fps}:d=${spec.seconds}:c0=${c0}:c1=${c1}:speed=0.03:seed=${spec.seed ?? 1}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    out,
  ]);
}
