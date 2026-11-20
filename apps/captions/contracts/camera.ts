/**
 * Camera curves: log footage → normal video (Rec.709) with each camera maker's own published conversion, what a file's
 * own metadata says it is, and .cube 3D LUTs. Pure and browser-safe: the Colour step (editor-steps/colour) runs it on
 * the server with file reads, the page with byte-range reads of the file it plays. A camera conversion is never a grade:
 * nothing here measures a picture to pick a look.
 */

export type Profile = "slog3" | "flog" | "flog2" | "applelog" | "vlog" | "clog2" | "clog3";
type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];
type XY = [number, number];

const D65: XY = [0.3127, 0.329];
const REC709: XY[] = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
const REC2020: XY[] = [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]];
const log10inv = (x: number) => 10 ** x;

/**
 * Each profile: its curve from code value (0–1, the 10-bit code / 1023) to scene-linear reflection (0.18 = 18% grey),
 * written as the maker's paper prints its decoding formula, and its gamut's primaries (white is D65 for all of them).
 */
export const PROFILES: Record<Profile, { label: string; decode: (v: number) => number; primaries: XY[] }> = {
  slog3: {
    label: "S-Log3",
    // Sony, Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3, Appendix
    decode: (v) => (v >= 171.2102946929 / 1023 ? log10inv((v * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01 : ((v * 1023 - 95) * 0.01125) / (171.2102946929 - 95)),
    primaries: [[0.766, 0.275], [0.225, 0.8], [0.089, -0.087]], // S-Gamut3.Cine
  },
  flog: {
    label: "F-Log",
    // Fujifilm, F-Log Data Sheet Ver.1.0, 2-3
    decode: (v) => (v >= 0.100537775223865 ? log10inv((v - 0.790453) / 0.344676) / 0.555556 - 0.009468 / 0.555556 : (v - 0.092864) / 8.735631),
    primaries: REC2020, // F-Log Gamut = ITU-R BT.2020
  },
  flog2: {
    label: "F-Log2",
    // Fujifilm, F-Log2 Data Sheet Ver.1.0, 2-3
    decode: (v) => (v >= 0.100686685370811 ? log10inv((v - 0.384316) / 0.245281) / 5.555556 - 0.064829 / 5.555556 : (v - 0.092864) / 8.799461),
    primaries: REC2020,
  },
  applelog: {
    label: "Apple Log",
    // Apple, Apple Log Profile White Paper (September 2023), Decoding function
    decode: (v) => {
      const [r0, rt, c, b, g, d] = [-0.05641088, 0.01, 47.28711236, 0.00964052, 0.08550479, 0.69336945];
      const pt = c * (rt - r0) ** 2;
      return v >= pt ? 2 ** ((v - d) / g) - b : v >= 0 ? Math.sqrt(v / c) + r0 : r0;
    },
    primaries: REC2020,
  },
  vlog: {
    label: "V-Log",
    // Panasonic, V-Log/V-Gamut Reference Manual (Rev.1.0, November 28, 2014), 3.2
    decode: (v) => (v < 0.181 ? (v - 0.125) / 5.6 : log10inv((v - 0.598206) / 0.241514) - 0.00873),
    primaries: [[0.73, 0.28], [0.165, 0.84], [0.1, -0.03]], // V-Gamut
  },
  clog2: {
    label: "C-Log2",
    // Canon, Canon Log Gamma Curves white paper (November 1st, 2018), Appendix [2][b]: x is scene linear, reflection = x * 0.9
    decode: (y) => 0.9 * (y < 0.092864125 ? -(log10inv((0.092864125 - y) / 0.24136077) - 1) / 87.099375 : (log10inv((y - 0.092864125) / 0.24136077) - 1) / 87.099375),
    primaries: [[0.74, 0.27], [0.17, 1.14], [0.08, -0.1]], // Cinema Gamut (Canon, PUB. DIM-1102-000)
  },
  clog3: {
    label: "C-Log3",
    // the same white paper, Appendix [3][b]
    decode: (y) =>
      0.9 *
      (y < 0.097465473
        ? -(log10inv((0.12783901 - y) / 0.36726845) - 1) / 14.98325
        : y <= 0.15277891
          ? (y - 0.12512219) / 1.9754798
          : (log10inv((y - 0.12240537) / 0.36726845) - 1) / 14.98325),
    primaries: [[0.74, 0.27], [0.17, 1.14], [0.08, -0.1]],
  },
};

const mul = (m: Mat, v: Vec): Vec => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) as Vec;
function inverse(m: Mat): Mat {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
/** RGB → XYZ for primaries and a white point (the normalised primary matrix, SMPTE RP 177). */
export function toXyz(p: XY[], w: XY = D65): Mat {
  const cols = p.map(([x, y]) => [x / y, 1, (1 - x - y) / y] as Vec);
  const P: Mat = [0, 1, 2].map((r) => cols.map((c) => c[r]!)) as Mat;
  const s = mul(inverse(P), [w[0] / w[1], 1, (1 - w[0] - w[1]) / w[1]]);
  return P.map((r) => r.map((v, j) => v * s[j]!)) as Mat;
}
/** Linear RGB in a camera's gamut → linear RGB in Rec.709 primaries (same D65 white, so no adaptation). */
export const gamutTo709 = (p: XY[]): Mat => {
  const a = toXyz(p);
  const b = inverse(toXyz(REC709));
  return b.map((r) => [0, 1, 2].map((j) => r[0] * a[0][j]! + r[1] * a[1][j]! + r[2] * a[2][j]!)) as Mat;
};

/**
 * The display transform, one channel: scene-linear (Rec.709 primaries) → a Rec.709 video signal. Negatives clipped,
 * values above KNEE rolled off towards 1 by a Reinhard shoulder, KNEE + (1 − KNEE) · u / (1 + u) with u = (x − KNEE) /
 * (1 − KNEE) (the same slope at the knee, identity below it, so 18% grey and skin are untouched; highlights several
 * stops over keep their steps and never clip), then the BT.709 OETF. Grey lands at 0.409 (41%), as a broadcast camera
 * puts it. ponytail: per channel, so very bright saturated colours lean towards white; a luminance roll-off when that shows.
 */
export const KNEE = 0.6;
export function display(l: number): number {
  const x = Math.max(0, l);
  const u = (x - KNEE) / (1 - KNEE);
  const t = x <= KNEE ? x : KNEE + (1 - KNEE) * (u / (1 + u));
  return t < 0.018 ? 4.5 * t : 1.099 * t ** 0.45 - 0.099;
}

/** A profile's whole conversion, code values (RGB 0–1) → Rec.709 video (RGB 0–1). */
export function convert(p: Profile): (rgb: Vec) => Vec {
  const { decode, primaries } = PROFILES[p];
  const m = gamutTo709(primaries);
  return (rgb) => mul(m, rgb.map(decode) as Vec).map(display) as Vec;
}

/** A .cube 3D LUT of `fn` (Adobe/Resolve layout: red changes fastest), as ffmpeg's lut3d reads it. */
export function cube(fn: (rgb: Vec) => Vec, size = 33): string {
  const lines = [`LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) lines.push(fn([r / (size - 1), g / (size - 1), b / (size - 1)]).map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(" "));
  return lines.join("\n") + "\n";
}

/**
 * A .cube file someone adds (a camera maker's, a colourist's): its 3D table, red changing fastest, or why it can't be used.
 * Only a 3D LUT: one with a 1D shaper (LUT_1D_SIZE) is refused, as the player and the engine apply the 3D table alone.
 */
export const LUT_MAX_BYTES = 48 << 20; // under the server's 50 MB request limit: a 65-point LUT is about 7 MB
/** A LUT in a workspace's library (GET /api/edit-steps/luts): its file is kept as it was added, read by id. */
export interface CameraLut {
  /** `lut_` and the start of the file's sha256 */
  id: string;
  name: string;
  /** points per side (33 for a 33×33×33 LUT) */
  size: number;
  bytes: number;
  addedAt: number;
}
export function readCube(text: string): { size: number; values: Float32Array; title?: string } | { error: string } {
  let size = 0;
  let title: string | undefined;
  let values: Float32Array | null = null;
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^[A-Z_]/.test(line)) {
      const [key, ...rest] = line.split(/\s+/);
      if (key === "LUT_1D_SIZE") return { error: "This .cube has a 1D shaper (LUT_1D_SIZE): export it as a 3D LUT only" };
      if (key === "TITLE") title = line.slice(5).trim().replace(/^"|"$/g, "");
      if (key === "LUT_3D_SIZE") {
        size = Number(rest[0]);
        if (!Number.isInteger(size) || size < 2 || size > 129) return { error: "Its LUT_3D_SIZE is not a size from 2 to 129" };
        values = new Float32Array(size ** 3 * 3);
      }
      continue; // DOMAIN_MIN, DOMAIN_MAX, LUT_3D_INPUT_RANGE and the like
    }
    if (!values) return { error: "It has no LUT_3D_SIZE line before its table" };
    const row = line.split(/\s+/).map(Number);
    // 16: well over any LUT's overshoot, under a table written in 0–255 or 0–1023 codes
    if (row.length !== 3 || row.some((v) => !Number.isFinite(v) || Math.abs(v) > 16)) return { error: `Line "${line.slice(0, 40)}" is not three numbers` };
    if (n >= values.length) return { error: `It has more than the ${size ** 3} rows a ${size}-point LUT has` };
    values.set(row, n);
    n += 3;
  }
  if (!values) return { error: "It has no LUT_3D_SIZE line: only 3D LUTs can be added" };
  if (n !== values.length) return { error: `It has ${n / 3} rows where a ${size}-point LUT has ${size ** 3}` };
  return { size, values, title };
}

/**
 * What a file's own metadata says (editor-steps/colour/README.md, "What the files say"): a log profile, "normal" (the
 * camera says it is not log), an unsupported log named as the file names it, or null (nothing either way).
 *  - Sony: the NonRealTimeMeta XML (a top-level box after moov): CaptureGammaEquation and CaptureColorPrimaries.
 *  - Fujifilm: the maker note in moov/udta/MVTG, tag 0x3803 (VideoRecordingMode): 0 normal, 0x10 F-Log, 0x20 HLG,
 *    0x30 F-Log2.
 */
export type Tag = { log: Profile } | { normal: true } | { other: string } | null;
export function readTag(meta: Uint8Array): Tag {
  // latin1 is one character per byte, so a string index is the byte offset
  const text = new TextDecoder("latin1").decode(meta);
  const item = (n: string) => new RegExp(`<Item name="${n}" value="([^"]*)"`).exec(text)?.[1];
  const gamma = item("CaptureGammaEquation");
  if (gamma) {
    const prim = item("CaptureColorPrimaries") ?? "";
    if (gamma === "s-log3-cine" && prim === "s-gamut3-cine") return { log: "slog3" };
    return gamma.startsWith("s-log") ? { other: `${gamma} with ${prim || "no"} colour primaries` } : { normal: true };
  }
  const at = text.indexOf("FUJIFILM\x0c\x00\x00\x00");
  if (at >= 0 && at + 14 <= meta.length) {
    const d = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
    const ifd = at + 12;
    const n = d.getUint16(ifd, true);
    for (let k = 0; k < n && ifd + 14 + 12 * k <= meta.length; k++) {
      const e = ifd + 2 + 12 * k;
      if (d.getUint16(e, true) !== 0x3803) continue;
      const mode = d.getUint32(e + 8, true);
      return mode === 0x10 ? { log: "flog" } : mode === 0x30 ? { log: "flog2" } : mode === 0 || mode === 0x20 ? { normal: true } : { other: `Fujifilm video mode 0x${mode.toString(16)}` };
    }
  }
  return null;
}

/** Bytes of a file from `offset`, up to `length`: fewer at its end, none past it. */
export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Every top-level box of a QuickTime/MP4 file but the media data, joined: where the makers put their metadata. A few
 * small reads (each box's header, then each metadata box), so the page can do it with HTTP byte ranges.
 */
export async function metaBoxes(read: ReadBytes): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let off = 0; ; ) {
    const h = await read(off, 16);
    if (h.length < 8) break;
    const d = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let n = d.getUint32(0);
    if (n === 1 && h.length >= 16) n = Number(d.getBigUint64(8));
    if (n === 0) break; // a box to the end of the file: the media data in every camera file
    if (n < 8) break;
    const type = String.fromCharCode(...h.subarray(4, 8));
    if (!["mdat", "free", "skip", "wide"].includes(type) && n <= 64 << 20) parts.push(await read(off, n));
    off += n;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}

/**
 * The camera curve a clip's file names (S-Log3, F-Log, F-Log2), read when a clip lands on the timeline, or null when the
 * file names none or one this can't convert. It only records what the file says: nothing applies until it is switched on.
 */
export async function detectCamera(read: ReadBytes): Promise<{ curve: Profile; from: "file" } | null> {
  const tag = readTag(await metaBoxes(read));
  return tag && "log" in tag ? { curve: tag.log, from: "file" } : null;
}
