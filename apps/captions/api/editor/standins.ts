import type { FootageIndex, GenSpec, SongBeats } from "../../contracts/edit-plan";
import type { ProbeSummary } from "../library/media/probe";
import { libraryDb } from "../library/db";
import { ffmpeg } from "../library/media/run";

/**
 * Stand-ins for the parts the plan step reads that are built beside it: the footage index (index.ts), a song's beats
 * and the generated clips (generate.ts). Each has the name and the answer's shape of the real one, so the plan step
 * moves over by its imports alone. Until then: a source is one shot, a song beats at a fixed tempo, and a generated
 * clip is a moving colour gradient.
 */

/** Every source as one shot, with what the library says is seen in it. Speech is filled in by the caller. */
export async function indexSources(versionIds: string[]): Promise<FootageIndex> {
  const db = libraryDb();
  const row = db.prepare("SELECT a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?");
  const desc = db.prepare("SELECT text FROM descriptions WHERE version_id = ? ORDER BY source = 'user' DESC LIMIT 1");
  const sources: FootageIndex["sources"] = [];
  for (const id of versionIds) {
    const r = row.get(id) as { title: string; probe: string | null } | undefined;
    const p = r?.probe ? (JSON.parse(r.probe) as ProbeSummary) : null;
    if (!r || !p) continue;
    const turned = p.rotation === 90 || p.rotation === 270;
    const picture = !!p.vcodec && !p.cover;
    const d = (desc.get(id) as { text: string } | undefined)?.text.replace(/\s+/g, " ").trim().slice(0, 300);
    sources.push({
      id,
      title: r.title,
      dur: p.duration,
      fps: p.fps || 30,
      w: picture ? (turned ? p.height : p.width) : 0,
      h: picture ? (turned ? p.width : p.height) : 0,
      speech: false,
      sound: !!p.acodec,
      shots: [{ a: 0, b: p.duration, motion: 0.5, ...(d ? { desc: d } : {}) }],
    });
  }
  return { sources };
}

/** The tempo a song is taken to have until its beats are measured. */
export const STAND_IN_BPM = 120;

/** A song's beats from `startS`, at STAND_IN_BPM: a downbeat every four, every bar's first beat strong. */
export async function songBeats(source: string, durS: number, startS = 0): Promise<SongBeats> {
  const step = 60 / STAND_IN_BPM;
  const beats: number[] = [];
  for (let t = startS; t < durS; t += step) beats.push(Math.round(t * 1000) / 1000);
  const downbeats = beats.filter((_, k) => k % 4 === 0);
  return { source, startS, bpm: STAND_IN_BPM, beats, downbeats, strong: downbeats, sections: [{ a: startS, b: durS, energy: 0.5 }] };
}

/** The generator's styles. */
export const styles = (): string[] => ["gradient"];

const colour = (c: string | undefined, d: string) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? `0x${c!.slice(1)}` : d);

/** A clip made from nothing: `spec.seconds` of a slowly moving gradient in its palette, `w`x`h` at `fps`, into `out` (.mp4). */
export async function generateClip(spec: GenSpec, out: string, size: { w: number; h: number; fps: number }): Promise<void> {
  const [c0, c1] = [colour(spec.palette?.[0], "0x101820"), colour(spec.palette?.[1], "0xf2aa4c")];
  await ffmpeg([
    "-f", "lavfi", "-i", `gradients=s=${size.w}x${size.h}:r=${size.fps}:d=${spec.seconds}:c0=${c0}:c1=${c1}:speed=0.03:seed=${spec.seed ?? 1}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    out,
  ]);
}
