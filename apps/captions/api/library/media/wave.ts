import { spawn } from "node:child_process";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { writeJsonAtomic } from "./run";

export const WAVE_PER_SECOND = 10;
const RATE = 8000; // samples per second read from ffmpeg
const PER_PEAK = RATE / WAVE_PER_SECOND;

/**
 * Peaks of the first audio stream: the largest absolute sample in each tenth of a second, 0..1, written as
 * `{ perSecond, peaks }`. A file with no audio writes an empty list. ffmpeg's raw s16le output is read in Node,
 * so no filter-graph output is parsed.
 */
export function makeWave(src: string, out: string, hasAudio: boolean): Promise<void> {
  if (!hasAudio) return writeJsonAtomic(out, { perSecond: WAVE_PER_SECOND, peaks: [] });
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", src,
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
