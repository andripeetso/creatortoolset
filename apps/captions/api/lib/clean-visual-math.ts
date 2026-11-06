import type {
  VisualStats,
  VpdqStats,
} from "../../contracts/clean-fingerprints";
import { pdqDistance } from "./clean-fingerprints";

export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** FFmpeg P6 images only. Consume exactly the header separator: pixel 0 may be whitespace. */
export function readPpm(buffer: Buffer): RgbImage {
  let offset = 0;
  const token = () => {
    while (offset < buffer.length) {
      if (buffer[offset] === 35) {
        while (offset < buffer.length && buffer[offset] !== 10) offset++;
      } else if (buffer[offset] <= 32) offset++;
      else break;
    }
    const start = offset;
    while (offset < buffer.length && buffer[offset] > 32) offset++;
    return buffer.subarray(start, offset).toString("ascii");
  };
  const magic = token(),
    width = Number(token()),
    height = Number(token()),
    max = Number(token());
  if (
    magic !== "P6" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4_000_000 ||
    max !== 255
  )
    throw new Error("Invalid analysis frame.");
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
  else if (
    buffer[offset] === 10 ||
    buffer[offset] === 32 ||
    buffer[offset] === 9
  )
    offset++;
  else throw new Error("Invalid analysis frame separator.");
  if (buffer.length - offset !== width * height * 3)
    throw new Error("Incomplete analysis frame.");
  return { width, height, data: buffer.subarray(offset) };
}

/** Bilinear square sampling matches the documented square analysis coordinates. */
export function resizeRgb(image: RgbImage, size: number): Float32Array {
  const output = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = Math.max(
        0,
        Math.min(image.width - 1, ((x + 0.5) * image.width) / size - 0.5),
      );
      const sy = Math.max(
        0,
        Math.min(image.height - 1, ((y + 0.5) * image.height) / size - 0.5),
      );
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(x0 + 1, image.width - 1),
        y1 = Math.min(y0 + 1, image.height - 1);
      for (let c = 0; c < 3; c++) {
        const a =
          image.data[(y0 * image.width + x0) * 3 + c] * (1 - sx + x0) +
          image.data[(y0 * image.width + x1) * 3 + c] * (sx - x0);
        const b =
          image.data[(y1 * image.width + x0) * 3 + c] * (1 - sx + x0) +
          image.data[(y1 * image.width + x1) * 3 + c] * (sx - x0);
        output[(y * size + x) * 3 + c] =
          (a * (1 - sy + y0) + b * (sy - y0)) / 255;
      }
    }
  return output;
}

function lab(rgb: Float32Array, i: number) {
  const linear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const r = linear(rgb[i]),
    g = linear(rgb[i + 1]),
    b = linear(rgb[i + 2]);
  const f = (v: number) =>
    v > 216 / 24389 ? Math.cbrt(v) : ((24389 / 27) * v + 16) / 116;
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function visualDifference(
  before: RgbImage,
  after: RgbImage,
): VisualStats {
  const a = resizeRgb(before, 64),
    b = resizeRgb(after, 64);
  let delta = 0;
  const totals = [0, 0],
    squares = [0, 0];
  for (let i = 0; i < a.length; i += 3) {
    const la = lab(a, i),
      lb = lab(b, i);
    delta += Math.hypot(...la.map((v, c) => v - lb[c]));
    for (const [side, rgb] of [a, b].entries()) {
      const luma = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
      totals[side] += luma;
      squares[side] += luma * luma;
    }
  }
  const n = a.length / 3;
  return {
    pairs: 1,
    colorDeltaE: delta / n,
    contrastBefore:
      100 * Math.sqrt(Math.max(0, squares[0] / n - (totals[0] / n) ** 2)),
    contrastAfter:
      100 * Math.sqrt(Math.max(0, squares[1] / n - (totals[1] / n) ** 2)),
    brightnessBefore: (100 * totals[0]) / n,
    brightnessAfter: (100 * totals[1]) / n,
  };
}
export function averageVisual(pairs: VisualStats[]): VisualStats {
  if (!pairs.length) throw new Error("No frame pairs were decoded.");
  const result = { ...pairs[0], pairs: pairs.length };
  for (const key of [
    "colorDeltaE",
    "contrastBefore",
    "contrastAfter",
    "brightnessBefore",
    "brightnessAfter",
  ] as const)
    result[key] =
      pairs.reduce((sum, pair) => sum + pair[key], 0) / pairs.length;
  return result;
}

export function matchVpdq(
  a: { hash: string; quality: number }[],
  b: { hash: string; quality: number }[],
  intervals = [1, 1],
): VpdqStats {
  const unique = (frames: typeof a) => [
    ...new Set(
      frames.filter((f) => f.quality >= 50).map((f) => f.hash.toLowerCase()),
    ),
  ];
  const aa = unique(a),
    bb = unique(b),
    am = new Set<string>(),
    bm = new Set<string>();
  for (const x of aa)
    for (const y of bb)
      if (pdqDistance(x, y) <= 31) {
        am.add(x);
        bm.add(y);
      }
  const side = (
    sampled: number,
    hashes: string[],
    matches: Set<string>,
    interval: number,
  ) => ({
    sampled,
    unique: hashes.length,
    matched: matches.size,
    percent:
      aa.length && bb.length ? (100 * matches.size) / hashes.length : null,
    interval,
  });
  return {
    implementation:
      "vPDQ unordered matching method with Meta PDQ; evenly sampled, capped at 64 frames per video",
    distanceLimit: 31,
    qualityMinimum: 50,
    before: side(a.length, aa, am, intervals[0]),
    after: side(b.length, bb, bm, intervals[1]),
  };
}

/** Global translation proxy, not optical flow or a camera-only stabilization score. */
export function motionWindow(frames: Uint8Array[], size = 64) {
  const shifts: ({ dx: number; dy: number } | null)[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1],
      b = frames[i];
    if (a.length !== size * size || b.length !== size * size)
      throw new Error("Invalid motion frame.");
    const stats = (p: Uint8Array) => {
      const mean = p.reduce((s, v) => s + v, 0) / p.length;
      return {
        mean,
        std: Math.sqrt(p.reduce((s, v) => s + (v - mean) ** 2, 0) / p.length),
      };
    };
    const sa = stats(a),
      sb = stats(b);
    if (Math.min(sa.std, sb.std) < 8) {
      shifts.push(null);
      continue;
    }
    let best = Infinity,
      dx = 0,
      dy = 0;
    for (let y = -4; y <= 4; y++)
      for (let x = -4; x <= 4; x++) {
        let error = 0;
        for (let yy = 6; yy < size - 6; yy += 2)
          for (let xx = 6; xx < size - 6; xx += 2)
            error += Math.abs(
              a[yy * size + xx] -
                sa.mean -
                (b[(yy + y) * size + xx + x] - sb.mean),
            );
        // Stable tie-breaking favors no motion on repeated textures.
        error += 0.0001 * (x * x + y * y);
        if (error < best) {
          best = error;
          dx = x;
          dy = y;
        }
      }
    const samples = Math.ceil((size - 12) / 2) ** 2;
    shifts.push(
      best / samples > 24 || Math.abs(dx) === 4 || Math.abs(dy) === 4
        ? null
        : { dx, dy },
    );
  }
  let sum = 0,
    validTriples = 0;
  for (let i = 1; i < shifts.length; i++) {
    const a = shifts[i - 1],
      b = shifts[i];
    if (a && b) {
      sum += (b.dx - a.dx) ** 2 + (b.dy - a.dy) ** 2;
      validTriples++;
    }
  }
  return {
    squaredAcceleration: sum,
    validTriples,
    rejectedPairs: shifts.filter((f) => !f).length,
  };
}
