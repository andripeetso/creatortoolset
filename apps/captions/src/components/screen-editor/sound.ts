import { ALL_FORMATS, Input, UrlSource, type InputAudioTrack } from "mediabunny";
import { VoiceMono } from "@/lib/screen-sound";
import { openTrackReader } from "@/lib/screen-sound-reader";

const RATE = 48_000;
const CHUNK = 0.4; // seconds of sound made at a time
const AHEAD = 1.2; // seconds of sound kept made ahead of what is heard
const LEAD = 0.15; // a start is heard this long after it is asked for: the sound starts that far into the picture
const SLIP = 0.2; // the sound and the picture this far apart: the sound starts again where the picture is
const SETTLED = 0.5; // this long after a start the picture is really moving: they are lined up once more, closer
const CLOSE = 0.045; // apart by more than this then: the sound starts again (a voice early by 61 ms was measured)

/**
 * The recording's sound while it is edited: the same mix the export writes (lib/screen-sound.ts), the voice in both
 * ears and the sound the Mac or the device played, each with its own switch. The video elements play nothing: a
 * video element plays only the file's first sound track (measured in the Mac's own WebKit: turning its tracks on and
 * off changes nothing that is heard), and a voice recorded on one channel of an audio interface in one ear.
 * It follows the picture's clock (`follow`, every screen refresh), so play, pause, a jump, the loop and the trim all
 * come to it the same way. `works` is false where the sound cannot be played like this (no Web Audio, a sound track
 * this browser cannot decode): the video then plays its own first track, as before.
 */
export class SoundPlayer {
  readonly works: Promise<boolean>;
  private ctx: AudioContext | null = null;
  private input: Input | null = null;
  private tracks: Promise<InputAudioTrack[]>;
  private voiceGain: GainNode | null = null;
  private soundGain: GainNode | null = null;
  private out: GainNode | null = null;
  /** Each start counts up: an older one that is still making sound stops. */
  private run = 0;
  /** Where the sound is: the picture's time `media` is heard at the context's time `at`. */
  private started: { media: number; at: number } | null = null;
  /** When to line the sound up with the picture once more (the context's time; 0: not to). */
  private recheck = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private readers: { close: () => void }[] = [];
  private ready = false;
  private voiceTrack: number | null;
  private soundTrack: number | null;
  private length: () => number;

  constructor(url: string, tracks: { voice: number | null; sound: number | null }, length: () => number) {
    this.voiceTrack = tracks.voice;
    this.soundTrack = tracks.sound;
    this.length = length;
    try {
      this.ctx = new AudioContext();
      const ctx = this.ctx;
      this.out = ctx.createGain();
      this.out.connect(ctx.destination);
      const mix = ctx.createGain();
      mix.connect(this.out);
      this.voiceGain = ctx.createGain();
      this.soundGain = ctx.createGain();
      this.voiceGain.connect(mix);
      this.soundGain.connect(mix);
      // the scratch tests listen here (before the editor's own mute); nothing in the app sets it
      (window as unknown as { __screenSoundTap?: (node: AudioNode) => void }).__screenSoundTap?.(mix);
    } catch {
      this.ctx = null;
    }
    this.input = this.ctx ? new Input({ source: new UrlSource(url), formats: ALL_FORMATS }) : null;
    const found = this.input ? this.input.getAudioTracks() : Promise.resolve([] as InputAudioTrack[]);
    this.tracks = found;
    this.works = (async () => {
      if (!this.ctx || (tracks.voice === null && tracks.sound === null)) return false;
      const all = await found.catch(() => [] as InputAudioTrack[]);
      for (const n of [tracks.voice, tracks.sound]) {
        if (n === null) continue;
        const track = all[n];
        if (!track || !(await track.canDecode().catch(() => false))) return false;
      }
      this.ready = true;
      return true;
    })();
    // a page that may not start sound by itself starts it with the first press in it
    const wake = () => void this.ctx?.resume().catch(() => {});
    window.addEventListener("pointerdown", wake, { once: true, capture: true });
    window.addEventListener("keydown", wake, { once: true, capture: true });
  }

  /** Which of the recorded sounds are heard: at once, also while it plays. */
  setHeard(voice: boolean, sound: boolean) {
    if (this.voiceGain) this.voiceGain.gain.value = voice ? 1 : 0;
    if (this.soundGain) this.soundGain.gain.value = sound ? 1 : 0;
  }

  setMuted(muted: boolean) {
    if (this.out) this.out.gain.value = muted ? 0 : 1;
  }

  /** The picture is `running` and at `t`: the sound starts, stops or starts again where the picture is. */
  follow(running: boolean, t: number) {
    const ctx = this.ctx;
    if (!this.ready || !ctx) return;
    if (!running) {
      if (this.started) this.stop();
      return;
    }
    if (this.started) {
      const apart = Math.abs(this.started.media + (ctx.currentTime - this.started.at) - t);
      // a video that was just told to play takes a moment to move: once it does, the sound is lined up again
      const settled = this.recheck > 0 && ctx.currentTime >= this.recheck;
      if (settled) this.recheck = 0;
      if (apart < (settled ? CLOSE : SLIP)) return;
      return this.start(t, !settled);
    }
    this.start(t, true);
  }

  private start(t: number, recheck: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stop();
    this.recheck = recheck ? ctx.currentTime + LEAD + SETTLED : 0;
    const run = ++this.run;
    void ctx.resume().catch(() => {});
    const media = t + LEAD;
    const at = ctx.currentTime + LEAD;
    this.started = { media, at };
    void this.make(run, media, at);
  }

  private async make(run: number, media: number, at: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const all = await this.tracks;
    const open = async (n: number | null) => (n === null || !all[n] ? null : await openTrackReader(all[n], media));
    const [voice, sound] = await Promise.all([open(this.voiceTrack), open(this.soundTrack)]);
    if (run !== this.run) {
      voice?.close();
      sound?.close();
      return;
    }
    this.readers = [voice, sound].filter((r): r is NonNullable<typeof r> => !!r);
    const mono = new VoiceMono();
    const n = Math.round(CHUNK * RATE);
    for (let i = 0; run === this.run; i++) {
      const from = media + i * CHUNK;
      if (from > this.length() + 0.5) break;
      const when = at + i * CHUNK;
      while (run === this.run && when - ctx.currentTime > AHEAD) await new Promise((r) => setTimeout(r, 100));
      if (run !== this.run) break;
      const parts: [AudioNode | null, Float32Array[]][] = [];
      if (voice) parts.push([this.voiceGain, [mono.mix(await voice.reader.read(from, n, RATE))]]);
      if (sound) parts.push([this.soundGain, await sound.reader.read(from, n, RATE)]);
      if (run !== this.run) break;
      for (const [into, planes] of parts) {
        if (!into) continue;
        const buffer = ctx.createBuffer(planes.length, n, RATE);
        planes.forEach((p, c) => buffer.copyToChannel(p as Float32Array<ArrayBuffer>, c));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(into);
        // made late (a busy Mac): the part already gone is left out, so it stays with the picture
        const late = ctx.currentTime - when;
        if (late >= CHUNK) continue;
        source.start(Math.max(when, ctx.currentTime), Math.max(0, late));
        this.playing.add(source);
        source.onended = () => this.playing.delete(source);
      }
    }
  }

  private stop() {
    this.run++;
    this.started = null;
    this.recheck = 0;
    this.playing.forEach((s) => {
      try {
        s.stop();
      } catch {
        // not started yet
      }
    });
    this.playing.clear();
    this.readers.forEach((r) => r.close());
    this.readers = [];
  }

  dispose() {
    this.stop();
    this.input?.dispose();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
