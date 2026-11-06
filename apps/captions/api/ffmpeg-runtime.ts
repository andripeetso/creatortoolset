import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Production deploys a checksum-pinned FFmpeg 7 build under runtime/.
 * FFMPEG_PATH is an explicit override; local development falls back to PATH.
 */
export function ffmpegCommand(): string {
  const override = process.env.FFMPEG_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`FFMPEG_PATH does not exist: ${override}`);
    }
    return override;
  }
  const bundled = path.resolve(process.cwd(), "runtime/ffmpeg");
  return existsSync(bundled) ? bundled : "ffmpeg";
}
