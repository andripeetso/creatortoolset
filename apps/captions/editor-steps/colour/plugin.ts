import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { convert, cube, metaBoxes, PROFILES, readTag, type Profile, type Tag } from "../../contracts/camera";
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

const VERSION = "1"; // the maths here: a change makes new copies

/** A file's metadata boxes, read by the camera module's reader (contracts/camera.ts) from the file. */
export async function metaFrom(file: string): Promise<Uint8Array> {
  const fh = await open(file, "r");
  try {
    return await metaBoxes(async (offset, length) => {
      const b = Buffer.alloc(length);
      return b.subarray(0, (await fh.read(b, 0, length, offset)).bytesRead);
    });
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
    const tag: Tag = ["arib-std-b67", "smpte2084"].includes(v.color_transfer) ? { normal: true } : readTag(await metaFrom(file));
    if (tag && "other" in tag) {
      note(`${name} is ${tag.other} from the file, which Colour doesn't convert`);
      continue;
    }
    let profile: Profile | undefined;
    let how = "from the file";
    if (tag && "log" in tag) profile = tag.log;
    else if (!tag && (await looksFlat(file, p.duration || 1))) {
      if (choice === "auto") {
        note(`${name} looks flat (log?) but its camera profile isn't in the file: pick it under Colour in Settings → Editor`);
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
          ], signal).then(() => {}),
        );
      } catch (e) {
        if (signal.aborted) break;
        throw new Error(`Colour could not convert ${name}: ${(e as Error).message}`);
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
  about: "Turns log footage (S-Log3, F-Log, Apple Log and more) into normal video on this computer, with about 1.4 GB of disk for each minute of video",
  kind: "editor",
  editor: {
    steps: [
      {
        id: "colour",
        title: "Colour",
        about:
          "Turns log footage into normal video with the camera maker's published conversion, with about 1.4 GB of disk for each minute of video.",
        order: 10,
        options: [
          {
            id: "profile",
            label: "Camera profile",
            kind: "choice",
            default: "auto",
            choices: [
              { value: "auto", label: "From the file" },
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
