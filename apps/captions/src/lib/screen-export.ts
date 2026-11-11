import { ALL_FORMATS, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, UrlSource } from "mediabunny";
import { VideoSample, VideoSampleSink } from "mediabunny";
import { drawFrame, pointerPath, type CameraImage, type ScreenEvents, type ScreenLook } from "./screen-recording";
import { allowHighH264 } from "./h264-level";
import { frameReader } from "./frame-reader";

/**
 * The recording with its look (zooms, pointer, background), made in this browser from the file as uploaded, at
 * `width`×`height`. The first sound track (the voice) comes along. `cameraUrl` is the camera file (same clock: its
 * t=0 is the screen's t=0); its frames are drawn over the picture. `trim` keeps only that part of the recording
 * (seconds); the look's times stay the recording's own. Returns the MP4.
 */
export async function renderScreenVideo(opts: {
  url: string;
  cameraUrl?: string;
  events: ScreenEvents;
  look: ScreenLook;
  width: number;
  height: number;
  trim?: { start: number; end: number };
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
  await allowHighH264(); // a large window's recording is H.264 level 6.0, which the Mac app's web view takes only this way
  // ponytail: the whole MP4 in memory (~75 MB a minute at 1080p); stream it to the upload if long recordings run out of memory
  const target = new BufferTarget();
  const input = new Input({ source: new UrlSource(opts.url), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const cameraInput = opts.cameraUrl ? new Input({ source: new UrlSource(opts.cameraUrl), formats: ALL_FORMATS }) : null;
  let camera: Awaited<ReturnType<typeof cameraSource>> = null;
  let reader: ReturnType<typeof frameReader> = null;
  try {
    reader = frameReader();
  } catch {
    reader = null;
  }
  const cut = opts.trim?.start ?? 0;
  try {
    camera = cameraInput ? await cameraSource(cameraInput) : null;
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      showWarnings: false,
      trim: opts.trim,
      video: {
        codec: "avc",
        quality: new Quality({ bitrate: Math.max(8_000_000, width * height * 5), bitrateMode: "variable" }),
        frameRate: 60,
        forceTranscode: true,
        processedWidth: width,
        processedHeight: height,
        process: async (sample) => {
          // the browser may close a frame image in the next microtask, so both images are taken right before drawing
          // a trimmed conversion hands over frames timed from the cut; the look and the camera go by the recording's time
          const t = sample.timestamp + cut;
          const cam = camera ? await camera.at(t) : null;
          const frame = sample.toCanvasImageSource();
          const W = sample.displayWidth;
          const H = sample.displayHeight;
          // A decoded frame is never drawn on the 2D canvas with a part of it asked for: the Mac's WebKit draws the
          // whole frame then (no zoom, a squeezed camera). The reader cuts the part; without one, and for the camera
          // (small), a bitmap of the frame is cut instead.
          const read = reader !== null && frame instanceof VideoFrame && reader.take(frame);
          const whole = read || !(frame instanceof VideoFrame) ? null : await createImageBitmap(frame);
          const camFrame = cam?.toCanvasImageSource();
          const camWhole = camFrame instanceof VideoFrame ? await createImageBitmap(camFrame) : null;
          const camImage: CameraImage | null =
            cam && camFrame ? { image: camWhole ?? camFrame, width: cam.displayWidth, height: cam.displayHeight } : null;
          drawFrame(ctx, whole ?? frame, W, H, t, look, path, events.clicks, camImage, {
            picture: read ? (src, w, h) => reader?.part(src, W, H, w, h) ?? null : undefined,
          });
          whole?.close();
          camWhole?.close();
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
    reader?.dispose();
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
