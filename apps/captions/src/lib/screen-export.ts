import { ALL_FORMATS, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, UrlSource } from "mediabunny";
import { drawFrame, pointerPath, type ScreenEvents, type ScreenLook } from "./screen-recording";

/**
 * The recording with its look (zooms, pointer, background), made in this browser from the file as uploaded, at
 * `width`×`height`. The first sound track (the voice) comes along. Returns the MP4.
 */
export async function renderScreenVideo(opts: {
  url: string;
  events: ScreenEvents;
  look: ScreenLook;
  width: number;
  height: number;
  onProgress: (p: number) => void;
  signal?: AbortSignal;
}): Promise<Blob> {
  const { events, look, width, height } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("This browser can't draw the video");
  const path = pointerPath(events);
  // ponytail: the whole MP4 in memory (~75 MB a minute at 1080p); stream it to the upload if long recordings run out of memory
  const target = new BufferTarget();
  const input = new Input({ source: new UrlSource(opts.url), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      showWarnings: false,
      video: {
        codec: "avc",
        quality: new Quality({ bitrate: Math.max(8_000_000, width * height * 5), bitrateMode: "variable" }),
        frameRate: 60,
        forceTranscode: true,
        processedWidth: width,
        processedHeight: height,
        process: (sample) => {
          const frame = sample.toCanvasImageSource();
          drawFrame(ctx, frame, sample.displayWidth, sample.displayHeight, sample.timestamp, look, path, events.clicks);
          return canvas;
        },
      },
      audio: { codec: "aac" },
    });
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.isVideoTrack())) {
      throw new Error(`This browser can't make the video (${conversion.discardedTracks.map((d) => d.reason).join(", ") || "no H.264 encoder"})`);
    }
    opts.signal?.addEventListener("abort", () => void conversion.cancel());
    conversion.onProgress = opts.onProgress;
    await conversion.execute();
    if (!target.buffer) throw new Error("The video came out empty");
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}
