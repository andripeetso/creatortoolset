// The sound of a screen recording as the editor plays it and the export writes it: the voice in both ears, the sound
// the Mac (or the device) played beside it, each heard or not as the look says. One mix for both, so what is heard
// while editing is what the video gets.
import type { ScreenEvents, ScreenLook } from "./screen-recording";

/** Where the voice and the recorded sound are among the file's sound tracks (null: not recorded). */
export function soundTracks(events: Pick<ScreenEvents, "audio">): { voice: number | null; sound: number | null } {
  // a log from before the tracks were named has the voice alone
  const names = events.audio ?? ["mic"];
  const voice = names.indexOf("mic");
  const sound = names.findIndex((n) => n === "system" || n === "device");
  return { voice: voice >= 0 ? voice : null, sound: sound >= 0 ? sound : null };
}

/** The tracks that are heard with this look: each one recorded and not switched off. */
export function heardTracks(look: Pick<ScreenLook, "voice" | "sound">, events: Pick<ScreenEvents, "audio">) {
  const { voice, sound } = soundTracks(events);
  return { voice: look.voice === false ? null : voice, sound: look.sound === false ? null : sound };
}

/**
 * The voice in one channel, which plays in both ears. A microphone on an audio interface comes in two (or more)
 * channels with the voice on the one it is plugged into and the others silent; the voice is made of the channels that
 * carry sound, the average of those that have been within 20 dB of the loudest so far, so a voice on one channel
 * keeps its level and the same voice on two comes through once. The Mac app records the voice like this since it
 * writes it in one channel; recordings from before have it in the left channel only.
 */
export class VoiceMono {
  private loudest: number[] = [];

  mix(planes: Float32Array[]): Float32Array {
    const n = planes[0]?.length ?? 0;
    if (planes.length <= 1) return planes[0] ?? new Float32Array(0);
    if (this.loudest.length !== planes.length) this.loudest = planes.map(() => 0);
    planes.forEach((p, c) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += p[i] * p[i];
      if (n) this.loudest[c] = Math.max(this.loudest[c], Math.sqrt(sum / n));
    });
    const top = Math.max(...this.loudest);
    const used = planes.filter((_, c) => this.loudest[c] >= top * 0.1);
    const out = new Float32Array(n);
    const share = 1 / used.length;
    for (const p of used) for (let i = 0; i < n; i++) out[i] += p[i] * share;
    return out;
  }
}

/** A decoded stretch of a track: its channels from `at` (seconds) at `rate`. */
export type SoundChunk = { at: number; rate: number; planes: Float32Array[] };

/**
 * A sound track read forward by time, whatever stretches it was decoded in: `read(t, n)` gives `n` frames from `t`
 * at `rate`, in the track's channels, silent where the track has nothing. Reading goes forward only (the editor
 * starts a new reader when it jumps back), and what lies behind is let go.
 */
export class TrackReader {
  private chunks: SoundChunk[] = [];
  private done = false;
  private next: () => Promise<SoundChunk | null>;
  readonly channels: number;

  constructor(next: () => Promise<SoundChunk | null>, channels: number) {
    this.next = next;
    this.channels = channels;
  }

  async read(t: number, n: number, rate: number): Promise<Float32Array[]> {
    const end = t + n / rate;
    const until = (c: SoundChunk) => c.at + (c.planes[0]?.length ?? 0) / c.rate;
    while (!this.done && (this.chunks.length === 0 || until(this.chunks[this.chunks.length - 1]) < end)) {
      const chunk = await this.next();
      if (chunk) this.chunks.push(chunk);
      else this.done = true;
    }
    this.chunks = this.chunks.filter((c) => until(c) > t);
    const out = Array.from({ length: this.channels }, () => new Float32Array(n));
    for (const c of this.chunks) {
      const len = c.planes[0]?.length ?? 0;
      const from = Math.max(0, Math.ceil((c.at - t) * rate - 1e-6));
      const to = Math.min(n, Math.ceil((until(c) - t) * rate - 1e-6));
      for (let j = from; j < to; j++) {
        const k = Math.round((t + j / rate - c.at) * c.rate);
        if (k < 0 || k >= len) continue;
        for (let ch = 0; ch < this.channels; ch++) out[ch][j] = (c.planes[ch] ?? c.planes[0])[k];
      }
    }
    return out;
  }
}

/**
 * The two ears of the mix: the voice in both, the recorded sound in its own two (one channel goes to both), added
 * and kept within full level.
 */
export function stereoMix(voice: Float32Array | null, sound: Float32Array[] | null, n: number): [Float32Array, Float32Array] {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const l = sound?.[0];
  const r = sound?.[1] ?? sound?.[0];
  for (let i = 0; i < n; i++) {
    const v = voice ? voice[i] : 0;
    left[i] = Math.max(-1, Math.min(1, v + (l ? l[i] : 0)));
    right[i] = Math.max(-1, Math.min(1, v + (r ? r[i] : 0)));
  }
  return [left, right];
}
