import { readFileSync } from "node:fs";
import path from "node:path";
import type { Timeline } from "../../contracts/editor";
import { env } from "../lib/env";
import { LOOKAWAY_KIND } from "../../contracts/devices";
import { libraryDb } from "../library/db";
import { writeJsonAtomic } from "../library/media/run";
import { readDraft } from "./store";

/**
 * Where the speaker's eyes leave the lens (reading notes, looking off): the stretches B-roll must cover, edge to edge
 * (broll.ts coverAways). A computer measures each camera take a few times a second (the Mac app with the Mac's own face
 * finder, the `lookaway` device step): the head's turn and tilt and where the eyes sit across the eye, or no face. Each
 * take is read against its own straight-ahead pose (the median of its samples, as the camera moves between takes), and
 * a sample is away when the head turned 12° or more, tilted 8° or more, or the eyes moved 0.15 eye widths across; a
 * run of four or more away samples (one second at four a second) is a look-away. The retired engine's thresholds,
 * calibrated on a real shoot by eye. A take where no face is found anywhere has no look-aways: nothing tells where its
 * lens is. Measured once per library version and kept.
 */

/** A sample: head turn and tilt in degrees, and the eyes' place across the eye (0 one corner, 1 the other); null = no face. */
export type GazeSample = [yaw: number, pitch: number, iris: number] | null;

/** One take's samples: `step` source frames apart, from frame 0, at the take's `fps`. */
export interface Gaze {
  fps: number;
  step: number;
  samples: GazeSample[];
}

export const YAW = 12;
export const PITCH = 8;
export const IRIS = 0.15;
export const MIN_SAMPLES = 4;
/** The most samples one take may send (four a second for three hours). */
export const MAX_SAMPLES = 4 * 3 * 3600;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The take's straight-ahead pose: the median turn, tilt and eye place over its samples with a face, or null for none. */
export function baseline(samples: GazeSample[]): [number, number, number] | null {
  const rows = samples.filter((s): s is [number, number, number] => !!s);
  return rows.length ? [median(rows.map((r) => r[0])), median(rows.map((r) => r[1])), median(rows.map((r) => r[2]))] : null;
}

/**
 * Whether a sample looks away from the pose. Tilt counts either way: which way a face finder signs it varies.
 * shortcut: the retired engine counted only a head going down (reading); count one direction once the Mac's sign is checked on a real shoot.
 */
export const away = (s: GazeSample, base: [number, number, number]): boolean =>
  !s || Math.abs(s[0] - base[0]) >= YAW || Math.abs(s[1] - base[1]) >= PITCH || Math.abs(s[2] - base[2]) >= IRIS;

/** The take's look-aways, [a, b) in its own frames: runs of MIN_SAMPLES away samples or more, each ending just past its last. */
export function stretches(g: Gaze): [number, number][] {
  const base = baseline(g.samples);
  if (!base) return [];
  const out: [number, number][] = [];
  let run = -1;
  const close = (k: number) => {
    if (run >= 0 && k - run >= MIN_SAMPLES) out.push([run * g.step, (k - 1) * g.step + 1]);
    run = -1;
  };
  g.samples.forEach((s, k) => (away(s, base) ? run < 0 && (run = k) : close(k)));
  close(g.samples.length);
  return out;
}

/** The parts of `spans` outside every one of `holes` ([a, b) frames). */
export function subtract(spans: [number, number][], holes: [number, number][]): [number, number][] {
  let out = spans;
  for (const [c, d] of holes) out = out.flatMap(([a, b]): [number, number][] => (d <= a || c >= b ? [[a, b]] : [...(a < c ? [[a, c] as [number, number]] : []), ...(d < b ? [[d, b] as [number, number]] : [])]));
  return out.filter(([a, b]) => b > a);
}

/** Where the cut's speaker track (V1) shows a look-away, [a, b) in timeline frames, from each take's stretches. */
export function onScreen(tl: Timeline, aways: Record<string, [number, number][]>): [number, number][] {
  const out: [number, number][] = [];
  for (const i of tl.tracks.V1.items) {
    const sfps = tl.sources[i.src]?.fps || tl.fps;
    const k = tl.fps / (sfps * (i.speed ?? 1)); // timeline frames per source frame
    const lo = i.in;
    const hi = i.in + i.len / k;
    for (const [a, b] of aways[i.src] ?? []) {
      const x = Math.max(a, lo);
      const y = Math.min(b, hi);
      if (y > x) out.push([i.rec + Math.round((x - lo) * k), i.rec + Math.round((y - lo) * k)]);
    }
  }
  return out.sort((p, q) => p[0] - q[0]);
}

export const gazeFile = (versionId: string) => path.join(env.dataDir, "editor", "cache", `${versionId}.gaze.json`);

/** A take's kept samples, or null when it was never measured. */
export function readGaze(versionId: string): Gaze | null {
  try {
    return JSON.parse(readFileSync(gazeFile(versionId), "utf8")) as Gaze;
  } catch {
    return null;
  }
}

/** The samples a computer sent for one take, checked, or null when they are not samples. */
export function parseGaze(b: unknown): Gaze | null {
  const o = b as Partial<Gaze> | null;
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!o || !ok(o.fps) || o.fps! <= 0 || o.fps! > 240 || !Number.isInteger(o.step) || o.step! < 1 || o.step! > 240) return null;
  if (!Array.isArray(o.samples) || o.samples.length > MAX_SAMPLES) return null;
  if (!o.samples.every((s) => s === null || (Array.isArray(s) && s.length === 3 && s.every(ok)))) return null;
  return { fps: o.fps!, step: o.step!, samples: o.samples };
}

export const saveGaze = (versionId: string, g: Gaze) => writeJsonAtomic(gazeFile(versionId), g);

/** The camera takes a version's cut shows on its speaker track that were never measured: what its `lookaway` step reads. */
export function gazeWanted(tl: Timeline): string[] {
  return [...new Set(tl.tracks.V1.items.map((i) => i.src))].filter((id) => !!tl.sources[id]?.w && !tl.sources[id]?.file && !readGaze(id));
}

/**
 * POST …/editor/job/:id/gaze/:version: one take's samples from the device that holds the version's `lookaway` step, for
 * a take that step reads. Returns why not, or null when they are kept.
 */
export async function gazeFromDevice(device: string, job: number, version: string, body: unknown): Promise<string | null> {
  const row = libraryDb().prepare("SELECT version_id FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running' AND kind = ?").get(job, device, LOOKAWAY_KIND) as { version_id: string } | undefined;
  if (!row) return "Not found";
  const cut = row.version_id.indexOf(":");
  const d = readDraft(row.version_id.slice(0, cut), row.version_id.slice(cut + 1));
  if (!d || !d.timeline.tracks.V1.items.some((i) => i.src === version)) return "Not found";
  const g = parseGaze(body);
  if (!g) return "Send { fps, step, samples: [[yaw, pitch, iris] or null, …] }";
  await saveGaze(version, g);
  return null;
}
