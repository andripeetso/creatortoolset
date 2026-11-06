import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile } from "node:fs/promises";
import { ffmpegCommand } from "../ffmpeg-runtime";
import type { CleanOptions } from "../../contracts/clean-workspace";

export const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};

/** Only the video (no cover art) and audio tracks; no tags, chapters or encoder stamps. */
export const CLEAN_ARGS = [
  "-map",
  "0:V",
  "-map",
  "0:a?",
  "-c",
  "copy",
  "-map_metadata",
  "-1",
  "-map_chapters",
  "-1",
  "-fflags",
  "+bitexact",
  "-flags:v",
  "+bitexact",
  "-flags:a",
  "+bitexact",
];

export interface Item {
  where: string;
  key: string;
  value: string;
}

export interface Probe {
  format?: {
    tags?: Record<string, string>;
    duration?: string;
    format_name?: string;
  };
  streams?: {
    index: number;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    level?: number;
    codec_type?: string;
    codec_name?: string;
    codec_tag_string?: string;
    disposition?: { attached_pic?: number };
    tags?: Record<string, string>;
    side_data_list?: { rotation?: number }[];
  }[];
  chapters?: unknown[];
}

// container plumbing every file has, and ffmpeg's neutral defaults (Matroska
// requires a muxing app, so a bitexact MKV/WebM always says plain "Lavf")
const STRUCTURAL = new Set([
  "major_brand",
  "minor_version",
  "compatible_brands",
  "vendor_id",
  "rotate",
  "DURATION",
]);
const NEUTRAL = new Set(["VideoHandler", "SoundHandler", "und", "Lavf"]);

/** Every piece of metadata in an ffprobe report, as rows for the page. */
export function metadataItems(probe: Probe): Item[] {
  const items: Item[] = [];
  const add = (where: string, tags: Record<string, string> = {}) => {
    for (const [key, value] of Object.entries(tags)) {
      if (!STRUCTURAL.has(key) && !NEUTRAL.has(value)) {
        items.push({ where, key, value: String(value).slice(0, 200) });
      }
    }
  };
  add("File", probe.format?.tags);
  for (const s of probe.streams ?? []) {
    const kind = s.disposition?.attached_pic
      ? "cover image"
      : (s.codec_type ?? "unknown");
    const where = `Track ${s.index} (${kind})`;
    if (kind !== "video" && kind !== "audio") {
      items.push({ where, key: "track", value: s.codec_tag_string ?? kind });
    }
    add(where, s.tags);
  }
  if (probe.chapters?.length) {
    items.push({
      where: "File",
      key: "chapters",
      value: String(probe.chapters.length),
    });
  }
  return items;
}

export function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const p = spawn(cmd, args);
    let out = "",
      err = "",
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure = error;
      p.kill("SIGKILL");
    };
    const abort = () =>
      stop(new DOMException("Render cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => stop(new Error(`${cmd} timed out.`)),
      10 * 60_000,
    );
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-8192)));
    p.on("error", (error) => {
      failure = error;
    });
    // Do not release the upload lock or remove output until the process exits.
    p.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").pop() || `${cmd} failed`));
    });
  });
}

export const probe = async (
  file: string,
  signal?: AbortSignal,
): Promise<Probe> =>
  JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-of",
        "json",
        "-show_chapters",
        // Full stream output works with older ffprobe section names too.
        "-show_format",
        "-show_streams",
        file,
      ],
      signal,
    ),
  );

export async function md5(file: string, signal?: AbortSignal): Promise<string> {
  const h = createHash("md5");
  for await (const chunk of createReadStream(file, { signal })) h.update(chunk);
  return h.digest("hex");
}

/** An MP4/MOV 'free' box of random size and bytes at the end; every player skips it. */
export function randomFreeBox(): Buffer {
  const pad = randomBytes(randomInt(16, 256));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + pad.length);
  head.write("free", 4);
  return Buffer.concat([head, pad]);
}

/** Every output starts from the retained original, never from another version. */
export async function createCleanCopy(
  input: string,
  output: string,
  options: CleanOptions,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (options.stripMetadata) {
    await run(
      ffmpegCommand(),
      ["-v", "error", "-y", "-i", input, ...CLEAN_ARGS, output],
      signal,
    );
  } else {
    await copyFile(input, output);
  }
  if (options.unique) await appendFile(output, randomFreeBox());
}

/** Dimensions after FFmpeg/browser display rotation, before editor adjustments. */
export function videoDimensions(info: Probe) {
  const video = info.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const rotation =
    video?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || 0;
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    width: (swap ? video?.height : video?.width) || 0,
    height: (swap ? video?.width : video?.height) || 0,
  };
}
