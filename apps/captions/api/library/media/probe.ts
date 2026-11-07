import { spawn } from "node:child_process";

/**
 * What the library keeps of a file's probe (tasks/media-library-plan.md, section 5). Built field by field from
 * ffprobe's output: the container's and streams' `tags` objects are never copied, so GPS and other metadata
 * cannot reach the database.
 */
export interface ProbeSummary {
  duration: number; // seconds
  width: number;
  height: number;
  fps: number;
  rotation: number; // 0 | 90 | 180 | 270, clockwise
  format: string;
  vcodec: string;
  pixFmt: string;
  acodec: string;
  capturedAt?: number; // ms, from the container's creation_time
  timecode?: string; // start timecode "HH:MM:SS:FF" (";" before FF for drop frame), when the file carries one
}

const TIMECODE = /^\d\d:\d\d:\d\d[:;]\d\d$/;

type Json = Record<string, any>;

const rate = (r: unknown) => {
  const [a, b] = String(r ?? "").split("/").map(Number);
  const fps = b ? a / b : a;
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps * 1000) / 1000 : 0;
};

export function parseProbe(json: { format?: Json; streams?: Json[] }): ProbeSummary {
  const v = json.streams?.find((s) => s.codec_type === "video");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  // Clockwise degrees to show the picture upright. ffmpeg 7 writes the display matrix as side data, where
  // rotation is the negative of that; older builds wrote a `rotate` tag already clockwise. Read both, copy neither.
  const matrix = v?.side_data_list?.find((d: Json) => d.rotation !== undefined)?.rotation;
  const turn = matrix !== undefined ? -Number(matrix) : Number(v?.tags?.rotate ?? 0);
  const capturedAt = Date.parse(json.format?.tags?.creation_time ?? "");
  // only a string in the strict timecode shape is kept, never the tag object
  const timecode = [v?.tags?.timecode, json.format?.tags?.timecode, ...(json.streams ?? []).map((s) => s.tags?.timecode)].find(
    (t) => typeof t === "string" && TIMECODE.test(t),
  ) as string | undefined;
  return {
    duration: Number(json.format?.duration) || 0,
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0,
    rotation: ((Math.round(turn) % 360) + 360) % 360,
    format: json.format?.format_name ?? "",
    vcodec: String(v?.codec_name ?? ""),
    pixFmt: String(v?.pix_fmt ?? ""),
    acodec: String(a?.codec_name ?? ""),
    ...(Number.isFinite(capturedAt) ? { capturedAt } : {}),
    ...(timecode ? { timecode } : {}),
  };
}

/** Probes a file with ffprobe. Rejects when ffprobe fails or the file is not media. */
export function probe(file: string): Promise<ProbeSummary> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited ${code}`));
      try {
        resolve(parseProbe(JSON.parse(out)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Plays in every current browser without a proxy (copied from review.ts's browserPlayable; S9 can share it). */
export function browserPlayable(p: Pick<ProbeSummary, "format" | "vcodec" | "pixFmt" | "acodec">): boolean {
  const audioOk = !p.acodec || ["aac", "mp3", "opus", "vorbis"].includes(p.acodec);
  const pixOk = !p.vcodec || ["yuv420p", "yuvj420p"].includes(p.pixFmt);
  const mp4 = p.format.includes("mp4") && ["h264", "av1", ""].includes(p.vcodec);
  const webm = p.format.includes("webm") && ["vp8", "vp9", "av1"].includes(p.vcodec);
  return audioOk && pixOk && (mp4 || webm);
}
