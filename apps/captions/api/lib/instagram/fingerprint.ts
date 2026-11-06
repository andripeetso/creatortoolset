import type { MediaFingerprint } from "./types";

/**
 * Perceptual fingerprints for slides, so a repost of the same reel or
 * carousel is recognised even though Instagram re-encodes every upload.
 *
 * A frame's hash is a 64-bit difference hash of a 9×8 grayscale
 * downscale: each bit says whether a pixel is brighter than its right
 * neighbour. Two encodes of the same picture land within a few bits of
 * each other; unrelated pictures differ in ~32. Videos carry a few
 * sampled frames plus their duration.
 */

export const HASH_W = 9;
export const HASH_H = 8;
const HASH_BITS = (HASH_W - 1) * HASH_H;

const IMAGE_MAX_DISTANCE = 8;
const FRAME_MAX_DISTANCE = 10;
/** Hashes with almost no structure (a flat colour, a black frame) match everything; ignore them. */
const DEGENERATE_MIN_BITS = 4;

export function dhashFromGray(pixels: Uint8Array, width = HASH_W, height = HASH_H): string {
  if (pixels.length < width * height) {
    throw new Error(`expected ${width * height} gray pixels, got ${pixels.length}`);
  }
  let hex = "";
  let nibble = 0;
  let filled = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const bit = pixels[y * width + x]! < pixels[y * width + x + 1]! ? 1 : 0;
      nibble = (nibble << 1) | bit;
      filled++;
      if (filled === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        filled = 0;
      }
    }
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

function popcount(hex: string): number {
  let n = 0;
  for (const ch of hex) {
    let x = parseInt(ch, 16);
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

export function isDegenerate(hash: string): boolean {
  const bits = popcount(hash);
  return bits < DEGENERATE_MIN_BITS || bits > HASH_BITS - DEGENERATE_MIN_BITS;
}

/** Where to sample a video: shortly after the start, the middle, and near the end. */
export function fingerprintFrameTimes(durationS: number): number[] {
  const d = Math.max(0, durationS);
  if (d <= 1.2) return [Number((d / 2).toFixed(2))];
  const out: number[] = [];
  for (const t of [0.5, d / 2, d - 1]) {
    const clamped = Math.min(Math.max(0, t), Math.max(0, d - 0.1));
    if (out.length && clamped - out[out.length - 1]! < 0.5) continue;
    out.push(Number(clamped.toFixed(2)));
  }
  return out;
}

export function sameMedia(a: MediaFingerprint, b: MediaFingerprint): boolean {
  if (!a.h.length || !b.h.length) return false;
  const video = a.d !== undefined || b.d !== undefined;
  if (!video) {
    const x = a.h[0]!;
    const y = b.h[0]!;
    if (isDegenerate(x) || isDegenerate(y)) return false;
    return hamming(x, y) <= IMAGE_MAX_DISTANCE;
  }
  if (a.d === undefined || b.d === undefined) return false;
  const tolerance = Math.max(1, 0.02 * Math.max(a.d, b.d));
  if (Math.abs(a.d - b.d) > tolerance) return false;
  const n = Math.min(a.h.length, b.h.length);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const x = a.h[i]!;
    const y = b.h[i]!;
    if (isDegenerate(x) || isDegenerate(y)) continue;
    if (hamming(x, y) <= FRAME_MAX_DISTANCE) hits++;
  }
  return hits >= (n >= 3 ? 2 : n);
}

/** Every slide must match its counterpart; a post with a different slide count is a different post. */
export function samePost(
  a: Array<MediaFingerprint | undefined>,
  b: Array<MediaFingerprint | undefined>,
): boolean {
  if (!a.length || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || !sameMedia(x, y)) return false;
  }
  return true;
}
