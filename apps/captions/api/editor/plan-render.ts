import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isVertical } from "../../contracts/design";
import type { PlanEffect, PlanText } from "../../contracts/edit-plan";
import type { Item, Timeline, TrackId } from "../../contracts/editor";
import { filterEscape, requireFontsDir } from "../export";
import { ffmpeg, ffmpegTo } from "../library/media/run";
import { frameDuration } from "./fcpxml";
import { fitted } from "./framing";
import { cdlFilter, type Cdl } from "./grade";
import { LETTERBOX, sourceSpan, speedAt } from "./plan";
import { fadeFilter, previewSize, shotFilter } from "./preview";

/**
 * The preview of a planned edit (plan.ts): each shot drawn with its speed, effects, entry and the texts over it, its
 * own sound where it plays it, then joined, with the song laid under the whole at full level. A shot whose speed ramps
 * is drawn as short stretches of steady speed (split where the ramp bends, then every RAMP_STEP_S), each at the speed
 * of its middle, which plays the same source seconds as the ramp does.
 */

const RAMP_STEP_S = 0.1;
/** The face text is drawn in when the plan names none of a design system's (Anton ships in public/fonts). */
const TEXT_FONT = "Anton-Regular.ttf";

/** The end of every shot's filter: converted to and marked as HD colour. */
export const TAIL = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";

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

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
/** A picture scaled to cover w×h, the middle kept, or the window at `focus` (where it moves). */
const cover = (src: { w: number; h: number }, w: number, h: number, focus?: { x: number; y: number }) => {
  const k = Math.max(w / src.w, h / src.h);
  const [sw, sh] = [even(src.w * k), even(src.h * k)];
  return `scale=${sw}:${sh},crop=${w}:${h}${focus ? `:${Math.round((sw - w) * focus.x)}:${Math.round((sh - h) * focus.y)}` : ""}`;
};

/**
 * The picture of one stretch before its effects, as the shot's frame says: input 0 is the shot; for an inset with
 * `under`, input 2 is the shot before it, playing on; for a split, inputs 2 and 3 are its other pictures. The other
 * frames need only input 0 (shotFilter draws fill, fit and an inset over black from the item's zoom).
 */
function framed(tl: Timeline, item: Item, s: Stretch, o: { grade?: Cdl; under?: { w: number; h: number } }): string[] {
  const src = tl.sources[item.src]!;
  const { w: PW, h: PH, k } = previewSize(tl);
  const [num, den] = frameDuration(tl.fps);
  const speed = `setpts=(PTS-STARTPTS)/${n4(s.speed)}`;
  // backwards: the stretch's own source seconds, read and reversed
  const head = item.fx?.some((f) => f.type === "reverse") ? [`trim=duration=${n4((s.frames / tl.fps) * s.speed + 1 / src.fps)}`, "reverse", speed] : [speed];
  const end = ["setsar=1", `fps=${den}/${num}`, ...(cdlFilter(o.grade) ? [cdlFilter(o.grade)] : []), "format=yuv420p"];
  const tidy = `setsar=1,fps=${den}/${num},format=yuv420p`;
  const f = fitted(src, tl.width, tl.height);
  if (item.split?.length) {
    const pics = [{ src, at: "", focus: item.focus }, ...item.split.map((p, j) => ({ src: tl.sources[p.src]!, at: `[${j + 2}:v]${speed},`, focus: p.focus }))];
    const h = pics.map((_, j) => (j < pics.length - 1 ? even(PH / pics.length) : PH - even(PH / pics.length) * (pics.length - 1)));
    const cells = pics.map((p, j) => `${j ? p.at : ""}${cover(p.src, PW, h[j]!, p.focus)},${tidy}[c${j}]`);
    return [...head, `${cells.join(";")};${pics.map((_, j) => `[c${j}]`).join("")}vstack=inputs=${pics.length}`, ...end];
  }
  if (item.frame === "blur") {
    return [...head, `split[pa][pb];[pa]${cover(src, PW, PH)},gblur=sigma=${Math.max(4, Math.round(PH / 18))},eq=brightness=-0.12[pbg];[pb]scale=${even(f.w * k)}:${even(f.h * k)}[pfg];[pbg][pfg]overlay=x=(W-w)/2:y=(H-h)/2`, ...end];
  }
  if (item.frame === "inset" && o.under) {
    const z = item.zoom ?? 1;
    const b = Math.max(2, Math.round(PH / 160));
    return [
      ...head,
      `scale=${even(f.w * k * z)}:${even(f.h * k * z)},pad=iw+${2 * b}:ih+${2 * b}:${b}:${b}:white,${tidy}[fg];[2:v]${speed},${cover(o.under, PW, PH)},${tidy},eq=brightness=-0.08[bg];[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2`,
      ...end,
    ];
  }
  const bar = Math.round((PH - PW / LETTERBOX) / 2);
  const base = [...head, shotFilter(tl, item, o.grade, item.frame === "letterbox" && bar > 0 ? PH - 2 * bar : undefined)];
  if (item.frame === "letterbox" && bar > 0) base.push(`drawbox=x=0:y=0:w=iw:h=${bar}:c=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:c=black:t=fill`);
  return base;
}

/**
 * The video filter of one stretch: steady speed, the shot framed as its frame says (framed: its zoom, the grade),
 * then its effects, its entry and the texts that fall on it. `at`: where the stretch starts on the timeline (seconds),
 * for the texts. Every effect's window is in the shot's own time. A split or an inset over the shot before reads
 * more inputs (framed), so the result goes in a filter_complex after [0:v].
 */
export function stretchFilter(tl: Timeline, item: Item, s: Stretch, at: number, o: { grade?: Cdl; texts?: TextOn[]; font?: string; under?: { w: number; h: number } } = {}): string {
  const { w: PW, h: PH } = previewSize(tl);
  const fx: PlanEffect[] = [...(item.fx ?? [])];
  if (item.enter === "flash") fx.push({ type: "flash", at: 0, dur: 0.12 });
  const out = framed(tl, item, s, o);
  const T = `(t+${n4(s.off)})`;

  // a stutter plays a slice again, a freeze holds a frame: frames repeated where they fall in this stretch, the
  // shot's length kept (its end is cut instead)
  let extra = 0;
  for (const f of fx.filter((x) => x.type === "stutter" || x.type === "freeze").sort((a, b) => ("at" in a ? (a.at ?? 0) : 0) - ("at" in b ? (b.at ?? 0) : 0))) {
    if (f.type !== "stutter" && f.type !== "freeze") continue;
    const f0 = Math.round(((f.at ?? 0) - s.off) * tl.fps);
    if (f0 < 0 || f0 >= s.frames) continue;
    const size = f.type === "stutter" ? Math.max(1, Math.round((f.dur ?? 0.1) * tl.fps)) : 1;
    const times = f.type === "stutter" ? Math.max(1, (f.amount ?? 3) - 1) : Math.max(1, Math.round((f.dur ?? 0.4) * tl.fps));
    out.push(`loop=loop=${times}:size=${size}:start=${f0 + extra}`);
    extra += times * size;
  }
  if (extra) {
    const [num, den] = frameDuration(tl.fps);
    out.push(`setpts=N*${num}/${den}/TB`);
  }

  // the frame's scale over time (punch, zoom) and a margin to shake in, drawn by one scale and a crop
  const scales: string[] = [];
  const dx: string[] = [];
  const dy: string[] = [];
  for (const f of fx) {
    if (f.type === "reverse") continue;
    const a = f.at ?? 0;
    if (f.type === "punch") {
      const k = f.amount ?? 1.2;
      // in at once, back out over 0.3 s
      scales.push(`if(${inside(s.off, a, a + 0.3)},${n4(k)}-${n4(k - 1)}*(${T}-${n4(a)})/0.3,1)`);
    } else if (f.type === "zoom") {
      const [z0, z1, d] = [f.from ?? 1, f.to ?? 1.2, Math.max(0.01, f.dur ?? 1)];
      scales.push(`if(lt(${T},${n4(a)}),${n4(z0)},if(lt(${T},${n4(a + d)}),${n4(z0)}+${n4(z1 - z0)}*(${T}-${n4(a)})/${n4(d)},${n4(z1)}))`);
    } else if (f.type === "zoomblur") {
      const d = Math.max(0.01, f.dur ?? 0.25);
      scales.push(`if(${inside(s.off, a, a + d)},1+${n4(0.15 * (f.amount ?? 0.6))}*(1-(${T}-${n4(a)})/${n4(d)}),1)`);
    } else if (f.type === "shake") {
      const m = 0.02 + 0.06 * (f.amount ?? 0.5);
      scales.push(n4(1 + 2 * m));
      dx.push(`if(${inside(s.off, a, a + (f.dur ?? 0.3))},${Math.round(m * PW)}*sin(${T}*83),0)`);
      dy.push(`if(${inside(s.off, a, a + (f.dur ?? 0.3))},${Math.round(m * PH)}*cos(${T}*71),0)`);
    }
  }
  if (scales.length) {
    // never under 1: a punch's float end (0.9999…) trunc'd 2 px under the crop, and ffmpeg failed or crashed
    const z = `max(1,${scales.map((x) => `(${x})`).join("*")})`;
    out.push(`scale=w='trunc(${PW}*${z}/2)*2':h='trunc(${PH}*${z}/2)*2':eval=frame`);
    // copied after the crop: a filter drawing in place over a crop of a frame whose size changes every frame (negate,
    // lut) crashes ffmpeg 9 (measured on 9.0.2)
    out.push(`crop=${PW}:${PH}:x='(iw-ow)/2${dx.map((x) => `+${x}`).join("")}':y='(ih-oh)/2${dy.map((x) => `+${x}`).join("")}'`, "copy");
  }
  let zb = 0;
  for (const f of fx) {
    if (f.type === "reverse") continue;
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
    else if (f.type === "zoomblur") {
      // the picture averaged with two larger copies of itself: streaks out from the middle
      const z = [1.04 + 0.08 * amt, 1.08 + 0.16 * amt].map((k) => `scale=${even(PW * k)}:${even(PH * k)},crop=${PW}:${PH}`);
      const l = (x: string) => `[zb${zb}${x}]`;
      out.push(`split=3${l("a")}${l("b")}${l("c")};${l("b")}${z[0]}${l("d")};${l("c")}${z[1]}${l("e")};${l("a")}${l("d")}blend=all_mode=average:${on}${l("f")};${l("f")}${l("e")}blend=all_mode=average:${on}`);
      zb++;
    }
  }
  if (item.enter === "whip") out.push(`gblur=sigma=40:sigmaV=0.01:enable='${inside(s.off, 0, 0.12)}'`);
  if (item.enter === "dissolve" && s.off === 0) out.push(`fade=t=in:st=0:d=${n4(Math.min(0.3, item.len / tl.fps / 2))}`);
  // ponytail: a dissolve fades in from black (a dip), as each shot is drawn on its own; a crossfade needs both shots in one graph

  for (const x of o.texts ?? []) {
    if (!o.font) break;
    const size = Math.round(Math.min(PH * 0.07, (PW * 1.7) / Math.max(4, x.text.length)));
    // a reel's buttons and caption cover its top 14 % and bottom 35 %
    const [top, bottom] = isVertical(tl.width, tl.height) ? ["0.14", "0.65"] : ["0.12", "0.82"];
    const y = x.place === "top" ? `h*${top}` : x.place === "bottom" ? `h*${bottom}-th` : "(h-th)/2";
    out.push(
      `drawtext=fontfile='${filterEscape(o.font)}':textfile='${filterEscape(x.file)}':fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(PH / 240))}:bordercolor=black:x=(w-tw)/2:y=${y}:enable='between(t+${n4(at)},${n4(x.at)},${n4(x.at + x.dur)})'`,
    );
  }
  // every shot ends in one colour space, so the joined preview never changes it between shots (a player or a later
  // filter would start over at each change)
  out.push(TAIL);
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
 * The clips on sound `tracks` (the sound effects on A3) as ffmpeg inputs (from input `first` on) and a filter that mixes
 * them under `bed` (a label) into [sfxm]: each one trimmed, at its level and fades, delayed to its place. Null when none
 * is heard. `files`: source key → file.
 */
export function sfxMix(tl: Timeline, files: Record<string, string>, first: number, bed: string, tracks: TrackId[] = ["A3"]): { inputs: string[]; filter: string } | null {
  // a muted track and a clip switched off are not heard
  const items = tracks.filter((t) => !tl.tracks[t]?.mute).flatMap((t) => tl.tracks[t]?.items ?? []).filter((it) => it.enabled !== false);
  if (!items.length) return null;
  const inputs: string[] = [];
  const chains: string[] = [];
  items.forEach((it, k) => {
    inputs.push("-ss", (it.in / tl.sources[it.src]!.fps).toFixed(6), "-i", files[it.src]!);
    const fades = fadeFilter(it, 0, it.len, tl.fps, true).map((f) => `${f},`).join("");
    chains.push(
      `[${first + k}:a]atrim=0:${(it.len / tl.fps).toFixed(6)},asetpts=PTS-STARTPTS,${it.gainDb ? `volume=${it.gainDb}dB,` : ""}${fades}adelay=${Math.round((it.rec / tl.fps) * 1000)}:all=1,aresample=48000,aformat=channel_layouts=stereo[f${k}]`,
    );
  });
  chains.push(`${bed}${items.map((_, k) => `[f${k}]`).join("")}amix=inputs=${items.length + 1}:duration=first:normalize=0[sfxm]`);
  return { inputs, filter: chains.join(";") };
}

/**
 * Renders a planned timeline into `out` (.mp4): V1's shots with their effects, the linked A1 sound where a shot plays
 * its own, the song on A2 at its level under all of it, and the sound effects on A3, brought to -14 LUFS as every preview is.
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
    const shots = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
    for (const [j, v] of shots.entries()) {
      const a = tl.tracks.A1.items.find((x) => v.link && x.link === v.link);
      const src = tl.sources[v.src]!;
      // an inset plays over the shot before it, from where that shot ends (pulled back when its source ends sooner)
      const prev = v.frame === "inset" ? shots[j - 1] : undefined;
      const under = prev && tl.sources[prev.src]!.w ? tl.sources[prev.src]! : undefined;
      const underFrom = prev && under ? Math.max(0, Math.min(prev.in / under.fps + sourceSpan(prev.len / tl.fps, prev.speed, prev.ramp), under.dur / under.fps - (v.len / tl.fps) * 4)) : 0;
      let srcOff = 0;
      for (const s of stretchesOf(v, tl.fps)) {
        if (signal?.aborted) throw new Error("Stopped");
        const seg = path.join(parts, `${String(list.length).padStart(4, "0")}.mov`);
        const at = secs(v.rec) + s.off;
        const from = v.in / src.fps + srcOff;
        const picture = src.w ? ["-ss", from.toFixed(6), "-i", files[v.src]!] : ["-f", "lavfi", "-i", `color=c=black:s=${PW}x${PH}:r=${den}/${num}`];
        const sound = a ? ["-ss", (a.in / tl.sources[a.src]!.fps + srcOff).toFixed(6), "-i", files[a.src]!] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
        const more = src.w
          ? [
              ...(under ? ["-ss", (underFrom + srcOff).toFixed(6), "-i", files[prev!.src]!] : []),
              ...(v.split ?? []).flatMap((p) => ["-ss", (p.in / tl.sources[p.src]!.fps + srcOff).toFixed(6), "-i", files[p.src]!]),
            ]
          : [];
        const af = [...(a ? atempo(s.speed) : []), ...(a?.gainDb ? [`volume=${a.gainDb}dB`] : []), "aresample=48000", "aformat=channel_layouts=stereo", "apad"];
        await ffmpeg([
          ...picture,
          ...sound,
          ...more,
          "-filter_complex", `[0:v]${src.w ? stretchFilter(tl, v, s, at, { grade, texts, font, ...(under ? { under } : {}) }) : "format=yuv420p"}[v]`,
          "-map", "[v]", "-map", "1:a:0",
          "-af", af.join(","),
          "-frames:v", String(s.frames), "-t", secs(s.frames).toFixed(6),
          "-fps_mode", "cfr", "-video_track_timescale", "90000",
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
    // nothing heard at all (every shot's sound off, no song): silence stays silence, as levelling it divides by zero
    const norm = songSrc || tl.tracks.A1.items.length || tl.tracks.A3.items.length ? "loudnorm=I=-14:TP=-1:LRA=11" : "anull";
    const songMix = songSrc
      ? `[0:a]aresample=48000[x];[1:a]atrim=0:${total.toFixed(6)},asetpts=PTS-STARTPTS,${song.gainDb ? `volume=${song.gainDb}dB,` : ""}aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=${Math.max(0, total - 0.6).toFixed(3)}:d=0.6[s];[x][s]amix=inputs=2:duration=first:normalize=0`
      : null;
    // the sound effects (A3) mix under the bed, after the song (sfxMix)
    const sfx = sfxMix(tl, files, songSrc ? 2 : 1, songMix ? "[m]" : "[0:a]");
    const mix = sfx
      ? `${songMix ? `${songMix}[m];` : ""}${sfx.filter};[sfxm]${norm}[a]`
      : songMix ? `${songMix},${norm}[a]` : `[0:a]${norm}[a]`;
    await ffmpegTo(out, [
      "-f", "concat", "-safe", "0", "-i", listFile,
      ...(songSrc ? ["-ss", (song.in / songSrc.fps).toFixed(6), "-i", files[song.src]!] : []),
      ...(sfx?.inputs ?? []),
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
