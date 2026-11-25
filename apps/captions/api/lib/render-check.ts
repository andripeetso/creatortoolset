import { ffprobe } from "../library/media/probe";
import { ffmpeg } from "../library/media/run";

/**
 * A finished file checked the way a viewer gets it (docs/video-output-checks-prd.md §4.2): a picture as long as asked,
 * its sound where wanted, the frame count where the app set the frame rate, and one frame read in the middle. `why` is
 * one short line for a tooltip, never ffmpeg's output.
 */
export interface RenderWant {
  duration: number;
  sound: boolean;
  /** only where the app sets the frame rate (D8): a burn-in keeps the source's, which may vary */
  fps?: number;
  width?: number;
  height?: number;
}

export type RenderCheck = { ok: true } | { ok: false; why: string };

const s = (x: number) => `${Math.abs(x).toFixed(1)} s`;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const rate = (r: unknown) => {
  const [a, b] = String(r ?? "").split("/").map(Number);
  return b ? a! / b : a || 0;
};
const num = (x: unknown) => (x === undefined || x === null || x === "" || Number.isNaN(Number(x)) ? undefined : Number(x));

export async function checkRender(file: string, want: RenderWant): Promise<RenderCheck> {
  const j = await ffprobe(file, ["-show_format", "-show_streams", ...(want.fps ? ["-count_packets"] : [])]).catch(() => null);
  if (!j) return { ok: false, why: "File could not be read" };
  const v = j.streams?.find((x) => x.codec_type === "video");
  if (!v) return { ok: false, why: "No picture" };
  const a = j.streams?.find((x) => x.codec_type === "audio");
  // a WebM's streams carry no duration of their own: the container's is the picture's
  const vDur = num(v.duration) ?? num(j.format?.duration) ?? 0;
  const fps = want.fps ?? (rate(v.avg_frame_rate) || 30);
  const off = vDur - want.duration;
  if (Math.abs(off) > 1 / fps + 0.05) return { ok: false, why: `Video is ${s(off)} ${off < 0 ? "short" : "long"}` };
  if (want.width && want.height && (v.width !== want.width || v.height !== want.height)) {
    return { ok: false, why: `Video is ${v.width}×${v.height}, not ${want.width}×${want.height}` };
  }
  if (want.fps) {
    const need = Math.ceil(want.duration * want.fps);
    const has = num(v.nb_read_packets) ?? 0;
    if (Math.abs(has - need) > 1) return { ok: false, why: `Video has ${has} frames, not ${need}` };
  }
  if (want.sound) {
    if (!a) return { ok: false, why: "No sound" };
    const aOff = (num(a.duration) ?? num(j.format?.duration) ?? 0) - vDur;
    if (Math.abs(aOff) > 0.1) return { ok: false, why: `Sound is ${s(aOff)} ${aOff < 0 ? "short" : "long"}` };
  }
  const mid = vDur / 2;
  // -xerror: a frame that does not decode ends ffmpeg with an error instead of a warning
  const read = await ffmpeg(["-xerror", "-ss", mid.toFixed(3), "-i", file, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], true).then(
    () => true,
    () => false,
  );
  return read ? { ok: true } : { ok: false, why: `Frame at ${clock(mid)} could not be read` };
}
