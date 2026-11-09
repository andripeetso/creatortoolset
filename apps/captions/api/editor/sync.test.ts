import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { SYNC_RATE, matchPair, voiceChannel } from "./sync";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-sync-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-sync-test-secret";

const { readEnergy } = await import("./analyze");

/** Seeded white noise: each seed is a different sound, so two takes with different seeds never match. */
function noise(seed: number, seconds: number, rate = SYNC_RATE): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  let s = seed | 0 || 1;
  for (let i = 0; i < x.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    x[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return x;
}

/** A recorder file: each channel's samples written as 16-bit WAV at `rate`. */
function wav(name: string, channels: Float32Array[], rate = SYNC_RATE): string {
  const file = path.join(dir, name);
  const n = channels[0]!.length;
  const inter = new Float32Array(n * channels.length);
  channels.forEach((c, ch) => {
    for (let i = 0; i < n; i++) inter[i * channels.length + ch] = c[i]!;
  });
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "f32le", "-ar", String(rate), "-ac", String(channels.length), "-i", "pipe:0", "-c:a", "pcm_s16le", file], {
    input: Buffer.from(inter.buffer),
  });
  return file;
}

/** Talk, pause, talk: a 180 Hz tone gated by a 0.7 Hz square wave. */
function talk(rate: number, seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => {
    const t = i / rate;
    return Math.sin(2 * Math.PI * 180 * t) * (Math.sin(2 * Math.PI * 0.7 * t) > 0 ? 1 : 0);
  });
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("matchPair", () => {
  let long: Float32Array;
  beforeAll(() => {
    long = noise(1, 60);
  });

  it("matches a pair whose sound starts 15 s later in the other file, and the offset flips with the order", async () => {
    const b = wav("long.wav", [long]);
    const a = wav("clip.wav", [long.subarray(15 * SYNC_RATE, 35 * SYNC_RATE)]);
    const m = await matchPair(a, b);
    expect(m).not.toBeNull();
    expect(m!.offset_s).toBeCloseTo(15, 2);
    expect(m!.score).toBeGreaterThan(0.9);
    expect((await matchPair(b, a))!.offset_s).toBeCloseTo(-15, 2);
  });

  it("rejects unrelated pairs", async () => {
    const b = wav("long.wav", [long]);
    const a = wav("other.wav", [noise(2, 20)]);
    expect(await matchPair(a, b)).toBeNull();
  });
});

describe("voiceChannel", () => {
  const rate = 16000;
  const speech = talk(rate, 60);
  // the close mic hears the talker loudly over a quiet floor; the room mic hears the same talk late and
  // quiet over a loud floor, so its gaps are never silent
  const floorA = noise(3, 60, rate);
  const floorB = noise(4, 60, rate);
  const close = speech.map((x, i) => x * 0.3 + floorA[i]! * 0.0005);
  const room = speech.map((_, i) => speech[(i - 400 + speech.length) % speech.length]! * 0.2 + floorB[i]! * 0.02);

  it("picks the closest mic's channel, whichever side it is on", async () => {
    expect(await voiceChannel(wav("close-left.wav", [close, room], rate))).toBe(0);
    expect(await voiceChannel(wav("close-right.wav", [room, close], rate))).toBe(1);
  });

  it("is null for one channel and for two channels carrying the same sound", async () => {
    expect(await voiceChannel(wav("mono.wav", [close], rate))).toBeNull();
    expect(await voiceChannel(wav("same.wav", [close, close], rate))).toBeNull();
  });

  it("the energy read takes the voice channel alone, not a mix of the two", async () => {
    // left silent, right a 0.5 tone for 0-1 s and 2-3 s: the mix would read half as loud
    const tone = Float32Array.from({ length: 3 * SYNC_RATE }, (_, i) => (i >= SYNC_RATE && i < 2 * SYNC_RATE ? 0 : 0.5 * Math.sin((2 * Math.PI * 440 * i) / SYNC_RATE)));
    const e = await readEnergy(wav("stereo-tone.wav", [new Float32Array(tone.length), tone]));
    expect(e[50]).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});
