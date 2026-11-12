import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../../api/ffmpeg-runtime";
import { definePlugin, type EditorStepInput } from "../../api/lib/plugin";
import { atomically, ffmpegSlot } from "../../api/library/media/run";
import { parseProbe } from "../../api/library/media/probe";

/**
 * Colour, an AI Editor step: log footage turned into normal video (Rec.709), on this computer, with each camera
 * maker's own published conversion (README.md lists the papers). It is never a grade: nothing is measured to pick a
 * look. A file is converted only when its own metadata says which log it is, or when the person picked the profile
 * under Colour in Settings → AI Editor and the file looks flat. A file that looks flat with no profile in it is left
 * alone and named in the edit's notes. The copy is the whole file again (ProRes 422 HQ, the source's frames, sound and
 * timecode), so a pack's grade still sits on top of it at preview.
 */

export type Profile = "slog3" | "flog" | "flog2" | "applelog" | "vlog" | "clog2" | "clog3";
type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];
type XY = [number, number];

const VERSION = "1"; // the maths here: a change makes new copies
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
 * What a file's own metadata says (README.md, "What the files say"): a log profile, "normal" (the camera says it is
 * not log), an unsupported log named as the file names it, or null (nothing either way).
 *  - Sony: the NonRealTimeMeta XML (a top-level box after moov): CaptureGammaEquation and CaptureColorPrimaries.
 *  - Fujifilm: the maker note in moov/udta/MVTG, tag 0x3803 (VideoRecordingMode): 0 normal, 0x10 F-Log, 0x20 HLG,
 *    0x30 F-Log2.
 */
export type Tag = { log: Profile } | { normal: true } | { other: string } | null;
export function readTag(meta: Buffer): Tag {
  const text = meta.toString("latin1");
  const item = (n: string) => new RegExp(`<Item name="${n}" value="([^"]*)"`).exec(text)?.[1];
  const gamma = item("CaptureGammaEquation");
  if (gamma) {
    const prim = item("CaptureColorPrimaries") ?? "";
    if (gamma === "s-log3-cine" && prim === "s-gamut3-cine") return { log: "slog3" };
    return gamma.startsWith("s-log") ? { other: `${gamma} with ${prim || "no"} colour primaries` } : { normal: true };
  }
  const at = meta.indexOf(Buffer.from("FUJIFILM\x0c\x00\x00\x00", "latin1"));
  if (at >= 0 && at + 14 <= meta.length) {
    const ifd = at + 12;
    const n = meta.readUInt16LE(ifd);
    for (let k = 0; k < n && ifd + 14 + 12 * k <= meta.length; k++) {
      const e = ifd + 2 + 12 * k;
      if (meta.readUInt16LE(e) !== 0x3803) continue;
      const mode = meta.readUInt32LE(e + 8);
      return mode === 0x10 ? { log: "flog" } : mode === 0x30 ? { log: "flog2" } : mode === 0 || mode === 0x20 ? { normal: true } : { other: `Fujifilm video mode 0x${mode.toString(16)}` };
    }
  }
  return null;
}

/** Every top-level box of a QuickTime/MP4 file but the media data, joined: where the makers put their metadata. */
export async function metaBoxes(file: string): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const parts: Buffer[] = [];
    for (let off = 0; off + 8 <= size; ) {
      const h = Buffer.alloc(16);
      await fh.read(h, 0, 16, off);
      let n = h.readUInt32BE(0);
      if (n === 1) n = Number(h.readBigUInt64BE(8));
      if (n === 0) n = size - off;
      if (n < 8) break;
      if (!["mdat", "free", "skip", "wide"].includes(h.toString("latin1", 4, 8)) && n <= 64 << 20) {
        const b = Buffer.alloc(n);
        await fh.read(b, 0, n, off);
        parts.push(b);
      }
      off += n;
    }
    return Buffer.concat(parts);
  } finally {
    await fh.close();
  }
}

/** One ffmpeg or ffprobe run in the server-wide limit, its stdout back; `signal` stops it (this process only). */
function capture(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(cmd, args);
        signal?.addEventListener("abort", () => p.kill(), { once: true });
        const out: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => out.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
      }),
  );
}
const ffprobeCommand = () => {
  const ff = ffmpegCommand();
  return path.isAbsolute(ff) && existsSync(path.join(path.dirname(ff), "ffprobe")) ? path.join(path.dirname(ff), "ffprobe") : "ffprobe";
};

/**
 * Looks flat: a few frames, as a player shows them (the file's own tags), have lifted blacks, a short range and little
 * colour (8-bit RGB, 64x36 frames). The thresholds sit between a camera's log footage (a Sony S-Log3 clip: blacks 63, range
 * 99, colour 13) and ordinary video (blacks under 20, range over 200). It only ever writes a note or lets a picked profile apply;
 * it never converts by itself. ponytail: a foggy shot can look flat too; that costs a note, nothing else.
 */
export const FLAT = { black: 25, range: 170, colour: 30 };
export function flatStats(rgb: Buffer): { black: number; range: number; colour: number } {
  const y: number[] = [];
  let colour = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const [r, g, b] = [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!];
    y.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    colour += Math.max(r, g, b) - Math.min(r, g, b);
  }
  y.sort((a, b) => a - b);
  const at = (q: number) => y[Math.min(y.length - 1, Math.floor(q * y.length))] ?? 0;
  return { black: at(0.02), range: at(0.98) - at(0.02), colour: colour / Math.max(1, y.length) };
}
export const isFlat = (s: ReturnType<typeof flatStats>) => s.black >= FLAT.black && s.range <= FLAT.range && s.colour <= FLAT.colour;

async function looksFlat(file: string, seconds: number): Promise<boolean> {
  const frames: Buffer[] = [];
  for (let i = 0; i < 5; i++) {
    const t = (seconds * (i + 0.5)) / 5;
    frames.push(await capture(ffmpegCommand(), ["-hide_banner", "-v", "error", "-nostdin", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=64:36:flags=area,format=rgb24", "-f", "rawvideo", "-"]));
  }
  return isFlat(flatStats(Buffer.concat(frames)));
}

let encoders: Promise<string[]> | undefined;
/** ProRes 422 HQ 10-bit: the Mac's own encoder when ffmpeg has it, else ffmpeg's (the same choice as the face steps). */
async function prores(): Promise<string[]> {
  const list = (await (encoders ??= capture(ffmpegCommand(), ["-hide_banner", "-encoders"]).then((b) => [b.toString()]).catch(() => [""])))[0]!;
  return list.includes("prores_videotoolbox")
    ? ["-c:v", "prores_videotoolbox", "-profile:v", "hq", "-pix_fmt", "p210le"]
    : ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"];
}

const IMAGE = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|dng)$/i;
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/**
 * The code values the curves take. The papers' codes are the file's own 10-bit codes (their IRE columns are
 * (code − 64) / 876: Sony 95 → 3.5%, Panasonic 128 → 7.3%), so a camera file is read as it is, whatever its range tag
 * says (a Sony S-Log3 clip's darkest pixels sit at 89–98, on its 0% code of 95). ProRes is the exception, a stated
 * guess: QuickTime hands its YCbCr out as video range (Canon's FAQ Q7), so it is expanded first.
 */
export const rangeOf = (codec: string) => (codec === "prores" ? "limited" : "full");

export async function convertColour({ files, timeline, values, workDir, signal, note }: EditorStepInput): Promise<Record<string, string>> {
  const choice = (values.profile ?? "auto") as Profile | "auto" | "off";
  const out: Record<string, string> = {};
  if (choice === "off") return out;
  const shown = new Set([...(timeline.tracks.V1?.items ?? []), ...(timeline.tracks.V2?.items ?? [])].map((i) => i.src));
  for (const id of shown) {
    const file = files[id];
    const src = timeline.sources[id];
    if (!file || !src || !(src.w > 0) || IMAGE.test(file) || signal.aborted) continue;
    const name = src.name || id;
    const json = JSON.parse((await capture(ffprobeCommand(), ["-v", "error", "-show_format", "-show_streams", "-of", "json", file])).toString());
    const p = parseProbe(json);
    const v = (json.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "video") ?? {};
    // an HDR file (HLG or PQ) is not log: left alone
    const tag: Tag = ["arib-std-b67", "smpte2084"].includes(v.color_transfer) ? { normal: true } : readTag(await metaBoxes(file));
    if (tag && "other" in tag) {
      note(`${name} is ${tag.other} from the file, which Colour doesn't convert`);
      continue;
    }
    let profile: Profile | undefined;
    let how = "from the file";
    if (tag && "log" in tag) profile = tag.log;
    else if (!tag && (await looksFlat(file, p.duration || 1))) {
      if (choice === "auto") {
        note(`${name} looks flat (log?) but its camera profile isn't in the file: pick it under Colour in Settings → AI Editor`);
        continue;
      }
      profile = choice;
      how = "as set under Colour";
    }
    if (!profile || signal.aborted) continue;
    const lut = cube(convert(profile));
    const range = rangeOf(v.codec_name);
    const matrix = v.color_space === "bt2020nc" || v.color_space === "bt2020c" ? "bt2020" : v.color_space === "bt709" ? "bt709" : profile === "applelog" ? "bt2020" : "bt709";
    const s = statSync(file);
    const key = sha1([VERSION, file, s.size, s.mtimeMs, profile, range, matrix, sha1(lut)].join("\n")).slice(0, 12);
    const dest = path.join(workDir, `${id}-${key}.mov`);
    if (!existsSync(dest)) {
      const lutFile = path.join(workDir, `${profile}-${sha1(lut).slice(0, 8)}.cube`);
      if (!existsSync(lutFile)) {
        await writeFile(`${lutFile}.part`, lut);
        await rename(`${lutFile}.part`, lutFile);
      }
      const enc = await prores();
      const quoted = `'${lutFile.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
      const vf = [
        `scale=in_range=${range}:in_color_matrix=${matrix}:out_range=full`,
        "format=gbrp16le",
        `lut3d=file=${quoted}:interp=tetrahedral`,
        "scale=out_color_matrix=bt709:out_range=limited",
        `format=${enc[enc.indexOf("-pix_fmt") + 1]}`,
        "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709", // the output flags alone write no tags
      ].join(",");
      try {
        await atomically(dest, (tmp) =>
          capture(ffmpegCommand(), [
            "-hide_banner", "-v", "error", "-nostdin", "-y", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-vf", vf, "-fps_mode", "passthrough", ...enc,
            "-c:a", "copy", "-map_metadata", "0", ...(p.timecode ? ["-timecode", p.timecode] : []), "-f", "mov", tmp,
          ], signal),
        );
      } catch (e) {
        if (signal.aborted) break;
        throw new Error(`Colour failed on ${name}: ${(e as Error).message}`);
      }
    }
    note(`${name}: ${PROFILES[profile].label} ${how}, converted to normal video`);
    out[id] = dest;
  }
  return out;
}

export default definePlugin({
  id: "editor-colour",
  name: "Colour",
  about: "Turns log footage (S-Log3, F-Log, Apple Log and more) into normal video, on this computer. About 1.4 GB of disk for each minute of video",
  editor: {
    steps: [
      {
        id: "colour",
        title: "Colour",
        about:
          "Turns log footage into normal video with the camera maker's own published conversion, when the file says which log it is or you pick it here. Never a grade or a look. Footage that only looks flat is left as it is and named in the edit's notes. About 1.4 GB of disk for each minute of video.",
        order: 10,
        options: [
          {
            id: "profile",
            label: "Camera profile",
            kind: "choice",
            default: "auto",
            choices: [
              { value: "auto", label: "Auto from the file" },
              { value: "slog3", label: "S-Log3" },
              { value: "flog", label: "F-Log" },
              { value: "flog2", label: "F-Log2" },
              { value: "applelog", label: "Apple Log" },
              { value: "vlog", label: "V-Log" },
              { value: "clog2", label: "C-Log2" },
              { value: "clog3", label: "C-Log3" },
              { value: "off", label: "Off" },
            ],
          },
        ],
        run: convertColour,
      },
    ],
  },
});
