import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanEffect, PlanText } from "../../contracts/edit-plan";
import type { Item, Timeline } from "../../contracts/editor";
import { filterEscape, requireFontsDir } from "../export";
import { ffmpeg, ffmpegTo } from "../library/media/run";
import { frameDuration } from "./fcpxml";
import type { Cdl } from "./grade";
import { speedAt } from "./plan";
import { previewSize, shotFilter } from "./preview";

/**
 * The preview of a planned edit (plan.ts): each shot drawn with its speed, effects, entry and the texts over it, its
 * own sound where it plays it, then joined, with the song laid under the whole at full level. A shot whose speed ramps
 * is drawn as short stretches of steady speed (split where the ramp bends, then every RAMP_STEP_S), each at the speed
 * of its middle, which plays the same source seconds as the ramp does.
 */

const RAMP_STEP_S = 0.1;
/** The face text is drawn in when the plan names none of a design system's (Anton ships in public/fonts). */
const TEXT_FONT = "Anton-Regular.ttf";

/** One stretch of steady speed of a shot: from `off` seconds into the shot, `frames` long. */
export interface Stretch {
  off: number;
  frames: number;
  speed: number;
}

/** A shot's stretches of steady speed. One for a shot without a ramp. */
export function stretchesOf(item: Pick<Item, "len" | "speed" | "ramp">, fps: number): Stretch[] {
  if (!item.ramp?.length) return [{ off: 0, frames: item.len, speed: item.speed ?? 1 }];
  const dur = item.len / fps;
  const bends = [0, ...item.ramp.map((p) => p.t).filter((t) => t > 0 && t < dur), dur];
  const cuts = new Set<number>();
  for (let k = 1; k < bends.length; k++) {
    const a = bends[k - 1]!;
    const n = Math.max(1, Math.ceil((bends[k]! - a) / RAMP_STEP_S));
    for (let j = 0; j <= n; j++) cuts.add(Math.round((a + ((bends[k]! - a) * j) / n) * fps));
  }
  const fs = [...cuts].filter((f) => f >= 0 && f <= item.len).sort((a, b) => a - b);
  const out: Stretch[] = [];
  for (let k = 1; k < fs.length; k++) {
    const frames = fs[k]! - fs[k - 1]!;
    if (frames > 0) out.push({ off: fs[k - 1]! / fps, frames, speed: speedAt(item.ramp, (fs[k - 1]! + fs[k]!) / 2 / fps) });
  }
  return out;
}

const n4 = (x: number) => (Math.round(x * 10000) / 10000).toString();
/** A window of the shot's own time, `t` being the stretch's time from `off` on. */
const inside = (off: number, a: number, b: number) => `between(t+${n4(off)},${n4(a)},${n4(b)})`;

/** A text over the timeline: the file its words are in (no escaping of what the AI wrote), when and where. */
export interface TextOn extends PlanText {
  file: string;
}

/**
 * The video filter of one stretch: steady speed, the shot framed as the timeline frames it (shotFilter: its zoom, the
 * grade), then its effects, its entry and the texts that fall on it. `at`: where the stretch starts on the timeline
 * (seconds), for the texts. Every effect's window is in the shot's own time.
 */
export function stretchFilter(tl: Timeline, item: Item, s: Stretch, at: number, o: { grade?: Cdl; texts?: TextOn[]; font?: string } = {}): string {
  const { w: PW, h: PH } = previewSize(tl);
  const fx: PlanEffect[] = [...(item.fx ?? [])];
  if (item.enter === "flash") fx.push({ type: "flash", at: 0, dur: 0.12 });
  const out = [`setpts=(PTS-STARTPTS)/${n4(s.speed)}`, shotFilter(tl, item, o.grade)];
  const T = `(t+${n4(s.off)})`;

  // the frame's scale over time (punch, zoom) and a margin to shake in, drawn by one scale and a crop
  const scales: string[] = [];
  const dx: string[] = [];
  const dy: string[] = [];
  for (const f of fx) {
    const a = f.at ?? 0;
    if (f.type === "punch") {
      const k = f.amount ?? 1.2;
      // in at once, back out over 0.3 s
      scales.push(`if(${inside(s.off, a, a + 0.3)},${n4(k)}-${n4(k - 1)}*(${T}-${n4(a)})/0.3,1)`);
    } else if (f.type === "zoom") {
      const [z0, z1, d] = [f.from ?? 1, f.to ?? 1.2, Math.max(0.01, f.dur ?? 1)];
      scales.push(`if(lt(${T},${n4(a)}),${n4(z0)},if(lt(${T},${n4(a + d)}),${n4(z0)}+${n4(z1 - z0)}*(${T}-${n4(a)})/${n4(d)},${n4(z1)}))`);
    } else if (f.type === "shake") {
      const m = 0.02 + 0.06 * (f.amount ?? 0.5);
      scales.push(n4(1 + 2 * m));
      dx.push(`if(${inside(s.off, a, a + (f.dur ?? 0.3))},${Math.round(m * PW)}*sin(${T}*83),0)`);
      dy.push(`if(${inside(s.off, a, a + (f.dur ?? 0.3))},${Math.round(m * PH)}*cos(${T}*71),0)`);
    }
  }
  if (scales.length) {
    const z = scales.map((x) => `(${x})`).join("*");
    out.push(`scale=w='trunc(${PW}*${z}/2)*2':h='trunc(${PH}*${z}/2)*2':eval=frame`);
    out.push(`crop=${PW}:${PH}:x='(iw-ow)/2${dx.map((x) => `+${x}`).join("")}':y='(ih-oh)/2${dy.map((x) => `+${x}`).join("")}'`);
  }
  for (const f of fx) {
    const a = f.at ?? 0;
    const b = a + ("dur" in f && f.dur ? f.dur : 0.3);
    const on = `enable='${inside(s.off, a, b)}'`;
    const amt = "amount" in f ? (f.amount ?? 0.5) : 0.5;
    if (f.type === "flash") {
      // white fades out over the flash; a colour is laid over it
      out.push(f.color ? `drawbox=c=0x${f.color.slice(1)}@0.85:t=fill:${on}` : `eq=brightness='if(${inside(s.off, a, b)},1-(${T}-${n4(a)})/${n4(b - a)},0)':eval=frame`);
    } else if (f.type === "glitch" || f.type === "rgb") {
      const px = Math.max(2, Math.round(amt * 0.04 * PW));
      out.push(`rgbashift=rh=${px}:bh=-${px}:gv=${f.type === "glitch" ? Math.round(px / 2) : 0}:${on}`);
      if (f.type === "glitch") out.push(`noise=alls=${Math.round(20 + 60 * amt)}:allf=t:${on}`);
    } else if (f.type === "blur") out.push(`gblur=sigma=${n4(1 + 24 * amt)}:${on}`);
    else if (f.type === "invert") out.push(`negate=${on}`);
    else if (f.type === "strobe") out.push(`negate=enable='${inside(s.off, a, b)}*lt(mod(n,4),2)'`);
  }
  if (item.enter === "whip") out.push(`gblur=sigma=40:sigmaV=0.01:enable='${inside(s.off, 0, 0.12)}'`);
  if (item.enter === "dissolve" && s.off === 0) out.push(`fade=t=in:st=0:d=${n4(Math.min(0.3, item.len / tl.fps / 2))}`);
  // ponytail: a dissolve fades in from black (a dip), as each shot is drawn on its own; a crossfade needs both shots in one graph

  for (const x of o.texts ?? []) {
    if (!o.font) break;
    const size = Math.round(Math.min(PH * 0.07, (PW * 1.7) / Math.max(4, x.text.length)));
    const y = x.place === "top" ? "h*0.12" : x.place === "bottom" ? "h*0.82-th" : "(h-th)/2";
    out.push(
      `drawtext=fontfile='${filterEscape(o.font)}':textfile='${filterEscape(x.file)}':fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(PH / 240))}:bordercolor=black:x=(w-tw)/2:y=${y}:enable='between(t+${n4(at)},${n4(x.at)},${n4(x.at + x.dur)})'`,
    );
  }
  out.push("format=yuv420p");
  return out.join(",");
}

/** atempo at `k` (it takes 0.5 to 100 at a time). */
export function atempo(k: number): string[] {
  const out: string[] = [];
  let r = k;
  while (r < 0.5) {
    out.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-4) out.push(`atempo=${n4(r)}`);
  return out;
}

/**
 * Renders a planned timeline into `out` (.mp4): V1's shots with their effects, the linked A1 sound where a shot plays
 * its own, and the song on A2 at its level under all of it, brought to -14 LUFS as every preview is.
 */
export async function renderPlanPreview(tl: Timeline, files: Record<string, string>, out: string, signal?: AbortSignal, grade?: Cdl): Promise<void> {
  const [num, den] = frameDuration(tl.fps);
  const secs = (frames: number) => (frames * num) / den;
  const parts = `${out}.parts`;
  await rm(parts, { recursive: true, force: true });
  await mkdir(parts, { recursive: true });
  try {
    const texts: TextOn[] = [];
    for (const [k, x] of (tl.plan?.texts ?? []).entries()) {
      const file = path.join(parts, `text-${k}.txt`);
      await writeFile(file, x.text);
      texts.push({ ...x, file });
    }
    const font = texts.length ? path.join(requireFontsDir(), TEXT_FONT) : undefined;
    const { w: PW, h: PH } = previewSize(tl);
    const list: string[] = [];
    let total = 0;
    for (const v of [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec)) {
      const a = tl.tracks.A1.items.find((x) => v.link && x.link === v.link);
      const src = tl.sources[v.src]!;
      let srcOff = 0;
      for (const s of stretchesOf(v, tl.fps)) {
        if (signal?.aborted) throw new Error("Stopped");
        const seg = path.join(parts, `${String(list.length).padStart(4, "0")}.mov`);
        const at = secs(v.rec) + s.off;
        const from = v.in / src.fps + srcOff;
        const picture = src.w ? ["-ss", from.toFixed(6), "-i", files[v.src]!] : ["-f", "lavfi", "-i", `color=c=black:s=${PW}x${PH}:r=${den}/${num}`];
        const sound = a ? ["-ss", (a.in / tl.sources[a.src]!.fps + srcOff).toFixed(6), "-i", files[a.src]!] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
        const af = [...(a ? atempo(s.speed) : []), ...(a?.gainDb ? [`volume=${a.gainDb}dB`] : []), "aresample=48000", "aformat=channel_layouts=stereo", "apad"];
        await ffmpeg([
          ...picture,
          ...sound,
          "-map", "0:v:0", "-map", "1:a:0",
          "-vf", src.w ? stretchFilter(tl, v, s, at, { grade, texts, font }) : "format=yuv420p",
          "-af", af.join(","),
          "-frames:v", String(s.frames), "-t", secs(s.frames).toFixed(6),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "pcm_s16le",
          seg,
        ]);
        list.push(`file '${seg.replace(/'/g, "'\\''")}'`);
        srcOff += secs(s.frames) * s.speed;
        total += secs(s.frames);
      }
    }
    if (!list.length) throw new Error("The plan has no shots");
    const listFile = path.join(parts, "list.txt");
    await writeFile(listFile, list.join("\n"));
    const song = tl.tracks.A2.items[0];
    const songSrc = song && tl.sources[song.src];
    const norm = "loudnorm=I=-14:TP=-1:LRA=11";
    const mix = songSrc
      ? `[0:a]aresample=48000[x];[1:a]atrim=0:${total.toFixed(6)},asetpts=PTS-STARTPTS,${song.gainDb ? `volume=${song.gainDb}dB,` : ""}aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=${Math.max(0, total - 0.6).toFixed(3)}:d=0.6[s];[x][s]amix=inputs=2:duration=first:normalize=0,${norm}[a]`
      : `[0:a]${norm}[a]`;
    await ffmpegTo(out, [
      "-f", "concat", "-safe", "0", "-i", listFile,
      ...(songSrc ? ["-ss", (song.in / songSrc.fps).toFixed(6), "-i", files[song.src]!] : []),
      "-filter_complex", mix,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy",
      "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
    ]);
  } finally {
    await rm(parts, { recursive: true, force: true });
  }
}
