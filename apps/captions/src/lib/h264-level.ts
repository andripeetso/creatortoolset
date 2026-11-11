// The Mac app's web view (WebKit) turns an H.264 file away by its name alone when the name says a level above 5.2
// ("avc1.64003c" is level 6.0), yet decodes the very same file when the name says 5.2. A screen recording of a large
// window is level 6.0 (3008×3130 at 60 frames a second), so its export stopped at "this browser can't make the video
// (undecodable_source_codec)". Where an engine does that, such files are decoded under the lower name. Measured in
// the Mac's own WebKit: 60 of 60 frames of a level 6.0 recording came out, at 3008×3130, with no error.
import { CustomVideoDecoder, VideoSample, registerDecoder, type EncodedPacket, type VideoCodec } from "mediabunny";

const LEVEL_5_2 = 0x34;

/** The level in an H.264 codec name, as its number ("avc1.64003c" gives 0x3c, level 6.0); 0 for any other name. */
export function h264Level(codec: string): number {
  const m = /^avc[13]\.[0-9a-f]{4}([0-9a-f]{2})$/i.exec(codec);
  return m ? parseInt(m[1], 16) : 0;
}

/** The same H.264 name at level 5.2. */
export const atLevel52 = (codec: string) => `${codec.slice(0, -2)}34`;

class AboveLevel52 extends CustomVideoDecoder {
  static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
    return codec === "avc" && h264Level(config.codec) > LEVEL_5_2;
  }

  private decoder: VideoDecoder | null = null;
  /** Frames not handed on yet, in the order they are shown. */
  private held: VideoSample[] = [];

  init() {
    this.decoder = new VideoDecoder({ output: (frame) => this.take(new VideoSample(frame)), error: (e) => this.onError(e) });
    this.decoder.configure({ ...this.config, codec: atLevel52(this.config.codec) });
  }

  // WebKit hands frames over in the order they are stored, which with B-frames is not the order they are shown:
  // each waits until a later one arrives, then all that waited go on in order
  private take(sample: VideoSample) {
    const held = this.held;
    if (held.length && sample.timestamp >= held[held.length - 1].timestamp) {
      for (const s of held) this.onSample(s);
      held.length = 0;
    }
    const at = held.findIndex((s) => s.timestamp > sample.timestamp);
    held.splice(at < 0 ? held.length : at, 0, sample);
  }

  async decode(packet: EncodedPacket) {
    const decoder = this.decoder;
    if (!decoder) return;
    decoder.decode(packet.toEncodedVideoChunk());
    // never more than a few frames ahead of what is drawn: a 4K frame is 37 MB
    while (decoder.state === "configured" && decoder.decodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
  }

  async flush() {
    await this.decoder?.flush();
    for (const s of this.held) this.onSample(s);
    this.held.length = 0;
  }

  close() {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    for (const s of this.held) s.close();
    this.held.length = 0;
  }
}

let asked: Promise<void> | null = null;

/**
 * Before an export: where this engine turns level 6.0 away by name but takes 5.2, files above 5.2 get the decoder
 * above. Asked once a page; an engine that takes level 6.0 as it is (Chrome) is left alone.
 */
export function allowHighH264(): Promise<void> {
  return (asked ??= (async () => {
    if (typeof VideoDecoder === "undefined") return;
    const takes = (codec: string) =>
      VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160 }).then(
        (r) => r.supported === true,
        () => false,
      );
    if (!(await takes("avc1.64003c")) && (await takes("avc1.640034"))) registerDecoder(AboveLevel52);
  })());
}
