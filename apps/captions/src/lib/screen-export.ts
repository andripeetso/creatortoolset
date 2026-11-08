import { ALL_FORMATS, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, UrlSource } from "mediabunny";
import { VideoSample, VideoSampleSink } from "mediabunny";
import { drawFrame, pointerPath, type CameraImage, type ScreenEvents, type ScreenLook } from "./screen-recording";

/**
 * The recording with its look (zooms, pointer, background), made in this browser from the file as uploaded, at
 * `width`×`height`. The first sound track (the voice) comes along. `cameraUrl` is the camera file (same clock: its
 * t=0 is the screen's t=0); its frames are drawn over the picture. Returns the MP4.
 */
export async function renderScreenVideo(opts: {
  url: string;
  cameraUrl?: string;
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
  const cameraInput = opts.cameraUrl ? new Input({ source: new UrlSource(opts.cameraUrl), formats: ALL_FORMATS }) : null;
  let camera: Awaited<ReturnType<typeof cameraSource>> = null;
  try {
    camera = cameraInput ? await cameraSource(cameraInput) : null;
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
        process: async (sample) => {
          // the browser may close a frame image in the next microtask, so both images are taken right before drawing
          const cam = camera ? await camera.at(sample.timestamp) : null;
          const frame = sample.toCanvasImageSource();
          const camImage: CameraImage | null = cam ? { image: cam.toCanvasImageSource(), width: cam.displayWidth, height: cam.displayHeight } : null;
          drawFrame(ctx, frame, sample.displayWidth, sample.displayHeight, sample.timestamp, look, path, events.clicks, camImage);
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
    await camera?.close();
    cameraInput?.dispose();
    input.dispose();
  }
}

/**
 * The camera's frames by time, read forward once: each call advances the decoder only as far as the requested time
 * (no seeking). Holds the current and the next frame; each frame is closed when passed. Returns null when the file
 * has no video track or the browser can't decode it.
 */
async function cameraSource(input: Input) {
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return null;
  const sink = new VideoSampleSink(track);
  const it = sink.samples();
  let current: VideoSample | null = null;
  let next: VideoSample | null = (await it.next()).value ?? null;
  return {
    /** The camera frame at t (or the last one before it); the caller takes its image right away. */
    async at(t: number): Promise<VideoSample | null> {
      while (next && next.timestamp <= t) {
        current?.close();
        current = next;
        next = (await it.next()).value ?? null;
      }
      return current;
    },
    async close() {
      current?.close();
      next?.close();
      current = next = null;
      await it.return(undefined);
    },
  };
}
