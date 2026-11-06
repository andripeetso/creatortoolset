import { retainedMetadataArgs } from "./clean-inspection";
import { FULL_CLEANUP } from "../../contracts/clean-inspection";
import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import {
  cropGeometry,
  hasAdjustments,
  type EditOptions,
  type VideoAdjustments,
} from "../../contracts/clean-edit";
import { editTimeline, timelineDuration } from "../../contracts/clean-timeline";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { CLEAN_ARGS, probe, run, videoDimensions } from "./clean-media";

export function editFilters(
  a: VideoAdjustments,
  width: number,
  height: number,
) {
  const g = cropGeometry(width, height, a);
  const filters = [`crop=${g.width}:${g.height}:${g.x}:${g.y}`];
  if (a.flipH) filters.push("hflip");
  if (a.flipV) filters.push("vflip");
  if (a.rotate === 90) filters.push("transpose=clock");
  if (a.rotate === 180) filters.push("hflip", "vflip");
  if (a.rotate === 270) filters.push("transpose=cclock");
  if (a.brightness !== 1 || a.contrast !== 1 || a.saturation !== 1) {
    // Same operation order as the browser's brightness / contrast / saturate preview.
    const curve = `clip((val*${a.brightness}-127.5)*${a.contrast}+127.5,0,255)`;
    filters.push(
      "format=gbrp",
      `lutrgb=r='${curve}':g='${curve}':b='${curve}'`,
    );
    const s = a.saturation;
    const l = [0.213, 0.715, 0.072];
    const channels = ["r", "g", "b"];
    filters.push(
      "colorchannelmixer=" +
        channels
          .flatMap((r, i) =>
            channels.map(
              (c, j) =>
                `${r}${c}=${(l[j] * (1 - s) + (i === j ? s : 0)).toFixed(6)}`,
            ),
          )
          .join(":"),
    );
  }
  filters.push("setsar=1", "format=yuv420p");
  return filters;
}

export async function validateEdit(
  input: string,
  options: EditOptions,
  signal?: AbortSignal,
) {
  const info = await probe(input, signal);
  const { width, height } = videoDimensions(info);
  const duration = Number(info.format?.duration);
  const video = info.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const rate = (video?.avg_frame_rate || "25/1").split("/").map(Number);
  const fps = rate[0] / rate[1];
  const frameStep = Number.isFinite(fps) && fps > 0 ? 1 / fps : 0.04;
  const a = options.adjustments;
  if (!width || !height || !Number.isFinite(duration) || duration <= 0)
    throw new Error(
      "This video cannot be edited: its size or duration is unavailable.",
    );
  const end = a.end ?? duration;
  const timeline = editTimeline(a, duration);
  if (
    !a.cuts.length &&
    (a.start >= duration || end > duration + 0.05 || end - a.start < 0.1)
  )
    throw new Error(
      "Choose a trim range inside the video, at least 0.1 seconds long.",
    );
  return {
    probe: info,
    width,
    height,
    duration,
    end: Math.min(end, duration),
    frameStep,
    fps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
    timeline,
    hasAudio: info.streams?.some((s) => s.codec_type === "audio") ?? false,
  };
}

export async function renderEdit(
  input: string,
  output: string,
  options: EditOptions,
  signal?: AbortSignal,
  validated?: Awaited<ReturnType<typeof validateEdit>>,
) {
  const info = validated ?? (await validateEdit(input, options, signal));
  const a = options.adjustments;
  // MOV can contain ProRes/PCM and other codecs that the MP4 muxer cannot copy.
  // Unknown codecs take the existing compatible H.264/AAC encoding path.
  const compatible = info.probe.streams
    ?.filter(
      (s) =>
        (s.codec_type === "video" && !s.disposition?.attached_pic) ||
        s.codec_type === "audio",
    )
    .every((s) =>
      (s.codec_type === "video"
        ? ["h264", "hevc", "av1", "mpeg4", "vp9"]
        : ["aac", "mp3", "ac3", "eac3", "alac"]
      ).includes(s.codec_name ?? ""),
    );
  const copy =
    !hasAdjustments(a) && /\.(mp4|m4v|mov)$/i.test(input) && compatible;
  const encoded = copy ? input : output + ".render.mp4";
  try {
    if (!copy)
      await renderAdjusted(
        input,
        encoded,
        { ...options, stripMetadata: true },
        signal,
        info,
      );
    await run(
      ffmpegCommand(),
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        encoded,
        ...CLEAN_ARGS,
        ...retainedMetadataArgs(
          info.probe,
          options.cleanup ?? FULL_CLEANUP,
          !copy,
          a.mute,
        ),
        "-movflags",
        "+faststart+use_metadata_tags",
        output,
      ],
      signal,
    );
    if (options.unique) await padEdit(input, output, options);
  } finally {
    if (!copy) await rm(encoded, { force: true });
  }
}

async function renderAdjusted(
  input: string,
  output: string,
  options: EditOptions,
  signal: AbortSignal | undefined,
  info: Awaited<ReturnType<typeof validateEdit>>,
) {
  const a = options.adjustments;
  // setpts drops the frame rate, so libx264 would size the H.264 level from
  // the time base (6.2 for any phone clip), and iOS Photos refuses the file.
  const rate = info.fps
    ? ["-x264-params", `fps=${(info.fps * a.speed).toFixed(3)}`]
    : [];
  if (a.cuts.length) {
    const audio = !a.mute && info.hasAudio;
    const graph: string[] = [];
    const n = info.timeline.length;
    // Seek each scene independently so reordering does not buffer the original
    // at full resolution while waiting for a later scene to reach concat.
    info.timeline.forEach((span, i) => {
      graph.push(
        `[${i}:V:0]trim=duration=${span.end - span.start},setpts=PTS-STARTPTS[v${i}]`,
      );
      if (audio)
        graph.push(
          `[${i}:a:0]atrim=duration=${span.end - span.start},asetpts=PTS-STARTPTS,apad,atrim=duration=${span.end - span.start}[a${i}]`,
        );
    });
    graph.push(
      `${info.timeline.map((_, i) => `[v${i}]${audio ? `[a${i}]` : ""}`).join("")}concat=n=${n}:v=1:a=${audio ? 1 : 0}[joined]${audio ? "[audio]" : ""}`,
    );
    graph.push(
      `[joined]${editFilters(a, info.width, info.height).join(",")},setpts=PTS/${a.speed}[video]`,
    );
    if (audio) graph.push(`[audio]atempo=${a.speed},volume=${a.volume}[sound]`);
    await run(
      ffmpegCommand(),
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        ...info.timeline.flatMap((span) => [
          "-threads",
          "2",
          "-ss",
          String(span.start),
          "-t",
          String(span.end - span.start),
          "-i",
          input,
        ]),
        "-filter_complex_threads",
        "2",
        "-filter_complex",
        graph.join(";"),
        "-map",
        "[video]",
        ...(audio
          ? ["-map", "[sound]", "-c:a", "aac", "-b:a", "192k"]
          : ["-an"]),
        "-t",
        String(timelineDuration(info.timeline)),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        ...rate,
        "-map_metadata",
        options.stripMetadata ? "-1" : "0",
        ...(options.stripMetadata
          ? [
              "-fflags",
              "+bitexact",
              "-flags:v",
              "+bitexact",
              "-flags:a",
              "+bitexact",
            ]
          : []),
        "-map_chapters",
        "-1",
        "-metadata:s:v:0",
        "rotate=0",
        ...(!options.stripMetadata ? ["-movflags", "+faststart"] : []),
        output,
      ],
      signal,
    );
    return;
  }
  const filters = editFilters(a, info.width, info.height);
  filters.push(`setpts=(PTS-STARTPTS)/${a.speed}`);
  await run(
    ffmpegCommand(),
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      String(a.start),
      "-i",
      input,
      "-t",
      String((info.end - a.start) / a.speed),
      "-map",
      "0:V:0",
      ...(a.mute ? ["-an"] : ["-map", "0:a:0?"]),
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      ...rate,
      ...(!a.mute
        ? [
            "-af",
            `asetpts=PTS-STARTPTS,atempo=${a.speed},volume=${a.volume}`,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
          ]
        : []),
      ...(options.stripMetadata
        ? [
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
          ]
        : ["-map_metadata", "0", "-map_chapters", "-1"]),
      "-metadata:s:v:0",
      "rotate=0",
      ...(!options.stripMetadata ? ["-movflags", "+faststart"] : []),
      output,
    ],
    signal,
  );
}

export async function renderEditFrame(
  input: string,
  output: string,
  options: EditOptions,
  seconds: number,
  signal?: AbortSignal,
) {
  const info = await validateEdit(input, options, signal);
  const time = Math.max(0, Math.min(seconds, info.duration - info.frameStep));
  const filters = editFilters(options.adjustments, info.width, info.height);
  filters.push(
    "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
  );
  await run(
    ffmpegCommand(),
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      String(time),
      "-i",
      input,
      "-map",
      "0:V:0",
      "-frames:v",
      "1",
      "-vf",
      filters.join(","),
      "-update",
      "1",
      output,
    ],
    signal,
  );
}

// A session gets distinct file bytes, while measuring and exporting the same
// settings produce the same output. Presets contain no session padding.
async function padEdit(input: string, output: string, options: EditOptions) {
  const pad = createHash("sha256")
    .update(input)
    .update(JSON.stringify(options))
    .digest();
  const header = Buffer.alloc(8);
  header.writeUInt32BE(pad.length + 8);
  header.write("free", 4);
  await appendFile(output, Buffer.concat([header, pad]));
}
