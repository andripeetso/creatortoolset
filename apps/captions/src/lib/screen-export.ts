import { ALL_FORMATS, AudioSample, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, UrlSource } from "mediabunny";
import { VideoSample, VideoSampleSink } from "mediabunny";
import { VoiceMono, heardTracks, stereoMix, type TrackReader } from "./screen-sound";
import { openTrackReader } from "./screen-sound-reader";
import { alphaPacking, drawFrame, pointerPath, type CameraImage, type CursorImages, type FaceAim, type ScreenEvents, type ScreenLook } from "./screen-recording";
import { allowHighH264 } from "./h264-level";
import { frameReader } from "./frame-reader";

/**
 * The recording with its look (zooms, pointer, background), made in this browser from the file as uploaded, at
 * `width`×`height`. The first sound track (the voice) comes along. `cameraUrl` is the camera file (same clock: its
 * t=0 is the screen's t=0); its frames are drawn over the picture. `trim` keeps only that part of the recording
 * (seconds); the look's times stay the recording's own. Returns the MP4.
 * The sound is the editor's mix (lib/screen-sound.ts): the voice in both ears and the sound the Mac or the device
 * played, each as the look's switches say; none at all when both are off or none was recorded.
 * `alpha` (a look with no background) makes the file the Mac app turns into a see-through video instead: each frame
 * twice in one picture, its colours over black and its matte (`alphaPacking`). It is not a video to watch.
 */
export async function renderScreenVideo(opts: {
  url: string;
  cameraUrl?: string;
  /** The same files already in the page (an older Mac app's recordings are read whole first): read instead of the URLs. */
  file?: Blob;
  cameraFile?: Blob;
  /** Where the camera's cut follows the face (faceFollower), for a look whose camera has `follow`. */
  faces?: FaceAim | null;
  /** The recording's cursors as images (events.cursors' order): the pointer as it really looked. */
  cursors?: CursorImages;
  events: ScreenEvents;
  look: ScreenLook;
  width: number;
  height: number;
  trim?: { start: number; end: number };
  alpha?: boolean;
  onProgress: (p: number) => void;
  signal?: AbortSignal;
}): Promise<Blob> {
  const { events, look, width, height } = opts;
  const packing = opts.alpha ? alphaPacking(width, height) : null;
  const canvas = document.createElement("canvas");
  canvas.width = packing?.width ?? width;
  canvas.height = packing?.height ?? height;
  const ctx = canvas.getContext("2d", { alpha: false });
  // a see-through frame is drawn on a canvas of its own (clear where nothing is), then packed; `matte` is its shape in white
  const layer = () => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c.getContext("2d");
  };
  const clear = packing ? layer() : null;
  const matte = packing ? layer() : null;
  if (!ctx || (packing && (!clear || !matte))) throw new Error("This browser can't draw the video");
  const path = pointerPath(events);
  await allowHighH264(); // a large window's recording is H.264 level 6.0, which the Mac app's web view takes only this way
  // ponytail: the whole MP4 in memory (~75 MB a minute at 1080p); stream it to the upload if long recordings run out of memory
  const target = new BufferTarget();
  const input = new Input({ source: opts.file ? new BlobSource(opts.file) : new UrlSource(opts.url), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const cameraInput = opts.cameraFile
    ? new Input({ source: new BlobSource(opts.cameraFile), formats: ALL_FORMATS })
    : opts.cameraUrl
      ? new Input({ source: new UrlSource(opts.cameraUrl), formats: ALL_FORMATS })
      : null;
  let camera: Awaited<ReturnType<typeof cameraSource>> = null;
  let reader: ReturnType<typeof frameReader> = null;
  try {
    reader = frameReader();
  } catch {
    reader = null;
  }
  const cut = opts.trim?.start ?? 0;
  const readers: { reader: TrackReader; close: () => void }[] = [];
  try {
    camera = cameraInput ? await cameraSource(cameraInput) : null;
    // the sound: what is heard is read from its own track and mixed; the conversion's own sound track only times it
    const heard = heardTracks(look, events);
    const audioTracks = await input.getAudioTracks();
    const open = async (n: number | null) => {
      const track = n === null ? undefined : audioTracks[n];
      const made = track ? await openTrackReader(track, cut) : null;
      if (made) readers.push(made);
      return made?.reader ?? null;
    };
    const voiceReader = await open(heard.voice);
    const soundReader = await open(heard.sound);
    const voice = new VoiceMono();
    const RATE = 48_000;
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      showWarnings: false,
      trim: opts.trim,
      video: {
        codec: "avc",
        // the packed picture is read once more by the app and thrown away: more bits, so its matte comes through clean
        quality: new Quality({
          bitrate: packing ? packing.width * packing.height * 8 : Math.max(8_000_000, width * height * 5),
          bitrateMode: "variable",
        }),
        frameRate: 60,
        forceTranscode: true,
        processedWidth: canvas.width,
        processedHeight: canvas.height,
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
            cam && camFrame ? { image: camWhole ?? camFrame, width: cam.displayWidth, height: cam.displayHeight, aim: opts.faces?.(t) } : null;
          clear?.clearRect(0, 0, width, height);
          drawFrame(clear ?? ctx, whole ?? frame, W, H, t, look, path, events.clicks, camImage, {
            pointer: { events, images: opts.cursors },
            picture: read ? (src, w, h) => reader?.part(src, W, H, w, h) ?? null : undefined,
          });
          whole?.close();
          camWhole?.close();
          if (packing && clear && matte) {
            // the colours over black, and beside or under them white kept only as far as the frame is opaque
            matte.globalCompositeOperation = "copy";
            matte.fillStyle = "#fff";
            matte.fillRect(0, 0, width, height);
            matte.globalCompositeOperation = "destination-in";
            matte.drawImage(clear.canvas, 0, 0);
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(clear.canvas, 0, 0);
            ctx.drawImage(matte.canvas, packing.layout === "beside" ? width : 0, packing.layout === "stacked" ? height : 0);
          }
          return canvas;
        },
      },
      audio:
        voiceReader || soundReader
          ? {
              codec: "aac",
              sampleRate: RATE,
              forceTranscode: true,
              processedNumberOfChannels: 2,
              processedSampleRate: RATE,
              process: async (sample) => {
                const n = sample.numberOfFrames;
                // a trimmed conversion hands over sound timed from the cut, like its frames
                const t = sample.timestamp + cut;
                const said = voiceReader ? voice.mix(await voiceReader.read(t, n, RATE)) : null;
                const played = soundReader ? await soundReader.read(t, n, RATE) : null;
                const [left, right] = stereoMix(said, played, n);
                const data = new Float32Array(n * 2);
                data.set(left, 0);
                data.set(right, n);
                const timestamp = sample.timestamp;
                sample.close();
                return new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: RATE, timestamp });
              },
            }
          : { discard: true },
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
    readers.forEach((r) => r.close());
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
