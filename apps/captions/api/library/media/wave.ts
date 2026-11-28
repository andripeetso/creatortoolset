import { ffmpegCommand } from "../../ffmpeg-runtime";
import { ffmpeg, NO_DECODER, spawnKillable, writeJsonAtomic } from "./run";

export const WAVE_PER_SECOND = 10;
const RATE = 8000; // samples per second read from ffmpeg
const PER_PEAK = RATE / WAVE_PER_SECOND;

function readWave(src: string, out: string, mapFirst: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawnKillable(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", src,
      ...(mapFirst ? ["-map", "0:a:0"] : []),
      "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1",
    ]);
    const peaks: number[] = [];
    let carry = Buffer.alloc(0);
    let max = 0;
    let count = 0;
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      const buf = Buffer.concat([carry, d]);
      const whole = buf.length - (buf.length % 2);
      for (let i = 0; i < whole; i += 2) {
        max = Math.max(max, Math.abs(buf.readInt16LE(i)));
        if (++count === PER_PEAK) {
          peaks.push(Math.round((max / 32768) * 1000) / 1000);
          max = 0;
          count = 0;
        }
      }
      carry = buf.subarray(whole);
    });
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", async (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
      if (count > 0) peaks.push(Math.round((max / 32768) * 1000) / 1000);
      try {
        await writeJsonAtomic(out, { perSecond: WAVE_PER_SECOND, peaks });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Peaks of the audio stream: the largest absolute sample in each tenth of a second, 0..1, written as
 * `{ perSecond, peaks }`. A file with no audio writes an empty list. ffmpeg's raw s16le output is read in Node,
 * so no filter-graph output is parsed. Falls back to 0:a:0 when ffmpeg picks an undecodable spatial track (apac).
 */
export function makeWave(src: string, out: string, hasAudio: boolean): Promise<void> {
  if (!hasAudio) return writeJsonAtomic(out, { perSecond: WAVE_PER_SECOND, peaks: [] });
  return readWave(src, out, false).catch((e: unknown) => {
    if (!NO_DECODER.test(e instanceof Error ? e.message : String(e))) throw e;
    return readWave(src, out, true);
  });
}

/** `len` seconds from the middle of `file`'s sound as a small mono mp3 at `out`: what sound-kind.ts lets Gemini hear. */
export const soundMiddle = (file: string, seconds: number, len: number, out: string): Promise<void> => {
  const args = (mapFirst: boolean) => [
    "-ss", String(Math.max(0, seconds / 2 - len / 2)), "-i", file, "-t", String(len),
    ...(mapFirst ? ["-map", "0:a:0"] : []),
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out,
  ];
  return ffmpeg(args(false)).catch((e: unknown) => {
    if (!NO_DECODER.test(e instanceof Error ? e.message : String(e))) throw e;
    return ffmpeg(args(true));
  });
};
