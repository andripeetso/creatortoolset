import type { ImageLayer } from "@contracts/design";

/**
 * What a picture layer does to its picture's colours, on plain RGBA bytes: the same numbers on the designer's canvas,
 * in the saved file and in the picture an AI is shown, since all three call this (lib/design/draw.ts). The picture is
 * given as it lies in its layer's box, so everything with a size or a place (blur, vignette, grain) is in the
 * design's own pixels: `scale` says how many of the given pixels one design pixel is. A see-through pixel stays
 * see-through, and one that is fully see-through is not touched.
 *
 * In order: exposure, warmth and tint (gains in linear light), shadows and highlights, contrast, all three as one
 * table a colour channel; then saturation, the two colours, blur, vignette and grain.
 */

export type Retouch = Pick<ImageLayer, "adjust" | "duotone" | "vignette" | "grain" | "blur">;

/** Whether a layer changes its picture at all: one that does not is drawn straight from the picture. */
export const retouches = (l: Retouch): boolean => !!(l.duotone || l.vignette || l.grain || l.blur || (l.adjust && Object.values(l.adjust).some(Boolean)));

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** sRGB's own curve, to light and back. */
const toLight = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLight = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
/** How bright a colour looks (Rec. 709 weights). */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * One table a channel (red, green, blue) for what changes each channel by itself. Each setting runs -100 to 100:
 * exposure two stops either way; warmth towards orange or blue and tint towards magenta or green, without making the
 * picture brighter or darker; shadows and highlights lift or lower the dark and the light end, leaving the ends
 * themselves; contrast steepens or flattens the middle, with black, mid-grey and white staying put.
 */
export function channelTables(a: NonNullable<Retouch["adjust"]>): [Uint8Array, Uint8Array, Uint8Array] {
  const n = (v: number | undefined) => Math.min(100, Math.max(-100, v ?? 0)) / 100;
  const warm = n(a.warmth) * 0.3;
  const tint = n(a.tint) * 0.3;
  const gains = [1 + warm, 1 - tint, 1 - warm];
  const stops = 2 ** (n(a.exposure) * 2) / luma(gains[0]!, gains[1]!, gains[2]!);
  const shadows = n(a.shadows);
  const highlights = n(a.highlights);
  // the middle's slope: 1 at none, about 2.3 at the most, 0.44 at the least
  const steep = 2 ** (n(a.contrast) * 1.2);
  return gains.map((gain) => {
    const table = new Uint8Array(256);
    for (let k = 0; k < 256; k++) {
      let v = clamp01(fromLight(toLight(k / 255) * gain * stops));
      // a bump over the dark half and one over the light half, each nothing at the ends and at the far end
      v = clamp01(v + shadows * 0.9 * v * (1 - v) ** 3 * 4 + highlights * 0.9 * v ** 3 * (1 - v) * 4);
      v = v < 0.5 ? 0.5 * (2 * v) ** steep : 1 - 0.5 * (2 - 2 * v) ** steep;
      table[k] = Math.round(clamp01(v) * 255);
    }
    return table;
  }) as [Uint8Array, Uint8Array, Uint8Array];
}

const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** A whole number from two, well mixed (32-bit): the same grain at every size the picture is drawn at, in every browser. */
function mixed(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967295;
}

/**
 * A soft blur of `radius` pixels: a box run three times each way, which is close to a true blur and costs the same
 * however wide it is. Colours are weighed by how see-through they are, so a cut-out's edge does not go dark, and the
 * picture's own edge is carried on outwards, so the blur does not fade at the box's sides.
 */
export function blurPixels(data: Uint8ClampedArray, w: number, h: number, radius: number): void {
  // a wide blur is worked on a smaller copy and brought back up: what a blur leaves has nothing finer than its own
  // width, so nothing seen is lost, and it costs a fraction (a slider dragged on a big picture stays quick)
  const smaller = Math.min(8, Math.floor(radius / 4));
  if (smaller >= 2) return blurSmaller(data, w, h, radius, smaller);
  const r = Math.max(1, Math.round(radius / 2));
  const size = w * h;
  // a channel at a time, so the room it works in is two numbers a pixel, not eight
  let from = new Float32Array(size);
  let to = new Float32Array(size);
  const span = 2 * r + 1;
  /** One box pass along every row. */
  const across = () => {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += from[row + Math.min(w - 1, Math.max(0, k))]!;
      for (let x = 0; x < w; x++) {
        to[row + x] = sum / span;
        sum += from[row + Math.min(w - 1, x + r + 1)]! - from[row + Math.max(0, x - r)]!;
      }
    }
    [from, to] = [to, from];
  };
  /** One box pass down every column, a row at a time with a sum a column: memory is read in the order it lies, which is several times quicker than a column at a time. */
  const sums = new Float64Array(w);
  const down = () => {
    sums.fill(0);
    for (let k = -r; k <= r; k++) {
      const row = Math.min(h - 1, Math.max(0, k)) * w;
      for (let x = 0; x < w; x++) sums[x]! += from[row + x]!;
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const add = Math.min(h - 1, y + r + 1) * w;
      const drop = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) {
        to[row + x] = sums[x]! / span;
        sums[x]! += from[add + x]! - from[drop + x]!;
      }
    }
    [from, to] = [to, from];
  };
  const blurred = () => {
    for (let n = 0; n < 3; n++) {
      across();
      down();
    }
  };
  const opaque = (() => {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
    return true;
  })();
  // each colour weighed by how see-through its pixel is; kept so in the picture's own bytes until the see-through
  // part is blurred too (all of this is skipped for a picture with nothing see-through, which most are)
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < size; i++) from[i] = opaque ? data[i * 4 + c]! : (data[i * 4 + c]! * data[i * 4 + 3]!) / 255;
    blurred();
    for (let i = 0; i < size; i++) data[i * 4 + c] = from[i]!;
  }
  if (opaque) return;
  for (let i = 0; i < size; i++) from[i] = data[i * 4 + 3]!;
  blurred();
  for (let i = 0; i < size; i++) {
    const a = from[i]!;
    const k = a > 0.5 ? 255 / a : 0;
    data[i * 4] = data[i * 4]! * k;
    data[i * 4 + 1] = data[i * 4 + 1]! * k;
    data[i * 4 + 2] = data[i * 4 + 2]! * k;
    data[i * 4 + 3] = a;
  }
}

/** `blurPixels` on a copy `k` times smaller each way. Colours are weighed by how see-through they are both ways, as in the blur itself. */
function blurSmaller(data: Uint8ClampedArray, w: number, h: number, radius: number, k: number): void {
  const sw = Math.ceil(w / k);
  const sh = Math.ceil(h / k);
  const small = new Uint8ClampedArray(sw * sh * 4);
  // down: each small pixel is its k × k pixels as one
  for (let sy = 0; sy < sh; sy++) {
    const yEnd = Math.min(h, sy * k + k);
    for (let sx = 0; sx < sw; sx++) {
      const xEnd = Math.min(w, sx * k + k);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = sy * k; y < yEnd; y++) {
        for (let i = (y * w + sx * k) * 4, end = (y * w + xEnd) * 4; i < end; i += 4) {
          const alpha = data[i + 3]!;
          r += data[i]! * alpha;
          g += data[i + 1]! * alpha;
          b += data[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (sy * sw + sx) * 4;
      if (a) {
        small[o] = r / a;
        small[o + 1] = g / a;
        small[o + 2] = b / a;
      }
      small[o + 3] = a / ((yEnd - sy * k) * (xEnd - sx * k));
    }
  }
  blurPixels(small, sw, sh, radius / k);
  // up: each pixel from the four small pixels round it, by how near each is. Where each column reads from is worked out once
  const left = new Int32Array(w);
  const right = new Int32Array(w);
  const across = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / k - 0.5));
    left[x] = Math.floor(fx) * 4;
    right[x] = Math.min(sw - 1, Math.floor(fx) + 1) * 4;
    across[x] = fx - Math.floor(fx);
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / k - 0.5));
    const top = Math.floor(fy) * sw * 4;
    const bottom = Math.min(sh - 1, Math.floor(fy) + 1) * sw * 4;
    const down = fy - Math.floor(fy);
    for (let x = 0; x < w; x++) {
      const tx = across[x]!;
      const p00 = top + left[x]!;
      const p01 = top + right[x]!;
      const p10 = bottom + left[x]!;
      const p11 = bottom + right[x]!;
      const w00 = (1 - tx) * (1 - down) * small[p00 + 3]!;
      const w01 = tx * (1 - down) * small[p01 + 3]!;
      const w10 = (1 - tx) * down * small[p10 + 3]!;
      const w11 = tx * down * small[p11 + 3]!;
      const a = w00 + w01 + w10 + w11;
      const i = (y * w + x) * 4;
      if (a > 0) {
        data[i] = (small[p00]! * w00 + small[p01]! * w01 + small[p10]! * w10 + small[p11]! * w11) / a;
        data[i + 1] = (small[p00 + 1]! * w00 + small[p01 + 1]! * w01 + small[p10 + 1]! * w10 + small[p11 + 1]! * w11) / a;
        data[i + 2] = (small[p00 + 2]! * w00 + small[p01 + 2]! * w01 + small[p10 + 2]! * w10 + small[p11 + 2]! * w11) / a;
      }
      data[i + 3] = a;
    }
  }
}

/** The picture's bytes (`w` × `h` pixels of its layer's box, `scale` of them a design pixel) with the layer's changes made, in place. */
export function retouch(data: Uint8ClampedArray, w: number, h: number, scale: number, l: Retouch): void {
  const tables = l.adjust && Object.values(l.adjust).some(Boolean) ? channelTables(l.adjust) : null;
  // saturation: every colour moved away from (or towards) its own grey; -100 is grey, 100 twice as far from it
  const colour = 1 + Math.min(100, Math.max(-100, l.adjust?.saturation ?? 0)) / 100;
  const dark = l.duotone && rgbOf(l.duotone.dark);
  const light = l.duotone && rgbOf(l.duotone.light);
  if (tables || colour !== 1 || dark) {
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      let r = tables ? tables[0][data[i]!]! : data[i]!;
      let g = tables ? tables[1][data[i + 1]!]! : data[i + 1]!;
      let b = tables ? tables[2][data[i + 2]!]! : data[i + 2]!;
      if (colour !== 1 || dark) {
        const grey = luma(r, g, b);
        if (dark && light) {
          // its darks become the one colour and its lights the other
          const t = grey / 255;
          r = dark[0] + (light[0] - dark[0]) * t;
          g = dark[1] + (light[1] - dark[1]) * t;
          b = dark[2] + (light[2] - dark[2]) * t;
        } else {
          r = grey + (r - grey) * colour;
          g = grey + (g - grey) * colour;
          b = grey + (b - grey) * colour;
        }
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  if (l.blur) blurPixels(data, w, h, l.blur * scale);
  const edge = Math.min(100, Math.max(-100, l.vignette ?? 0)) / 100;
  const grain = Math.min(100, Math.max(0, l.grain ?? 0)) / 100;
  if (!edge && !grain) return;
  // a grain is two design pixels across
  const cell = 2 * scale;
  for (let y = 0; y < h; y++) {
    // how far from the middle, 0 there and 1 in the corners, in the box's own shape
    const dy = (2 * (y + 0.5)) / h - 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!data[i + 3]) continue;
      let r = data[i]!;
      let g = data[i + 1]!;
      let b = data[i + 2]!;
      if (edge) {
        const dx = (2 * (x + 0.5)) / w - 1;
        // nothing inside the middle third, all of it at the corners
        const far = clamp01((Math.sqrt((dx * dx + dy * dy) / 2) - 0.35) / 0.65);
        const by = far * far * (3 - 2 * far) * Math.abs(edge) * 0.85;
        const towards = edge > 0 ? 0 : 255;
        r += (towards - r) * by;
        g += (towards - g) * by;
        b += (towards - b) * by;
      }
      if (grain) {
        // strongest in the middle greys, where film shows it, and gone at black and white
        const mid = luma(r, g, b) / 255;
        const by = (mixed(Math.floor(x / cell), Math.floor(y / cell)) - 0.5) * grain * 90 * (0.35 + 2.6 * mid * (1 - mid));
        r += by;
        g += by;
        b += by;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}
