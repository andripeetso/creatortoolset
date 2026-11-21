import type { Line, LineTakes, Sentence, TakeCut, TimelineSource } from "../../contracts/editor";
import { libraryDb } from "../library/db";
import type { ProbeSummary } from "../library/media/probe";
import { wordsOf, type TimedWord } from "../library/transcribe";
import { energyOf } from "./analyze";
import { cutTake, type CutSettings } from "./cut";
import { sourceOf } from "./timeline";

/**
 * The take picker's takes of one line (the draft page's side panel): each take cut as the draft step cuts it (cut.ts),
 * so a take tried on the timeline plays as a redraft would lay it. Reads only what analyze kept: a source whose loudness
 * isn't measured yet is cut by its words alone, never decoded here.
 */
export function takeCuts(line: Line, sentences: Sentence[], words: Record<string, TimedWord[]>, energy: Record<string, Float32Array>,
  fps: Record<string, number>, cut?: CutSettings): TakeCut[] {
  const byN = new Map(sentences.map((s) => [s.n, s]));
  return line.takes.flatMap((t) => {
    const a = byN.get(t.first);
    const b = byN.get(t.last);
    if (!a || !b || a.src !== b.src || !fps[a.src]) return [];
    const c = cutTake(words[a.src] ?? [], a.w0, b.w1 + 1, line.text, energy[a.src] ?? new Float32Array(), fps[a.src]!, cut);
    // no speech found by the cut: the take as said, first word to last
    const parts = c.segments.length ? c.segments : [[Math.round(a.s * fps[a.src]!), Math.round(b.e * fps[a.src]!)] as [number, number]];
    return [{ ...t, src: a.src, s: a.s, e: b.e, cut: parts.filter(([x, y]) => y > x) }];
  });
}

/** The line's takes with their sources from the library (a source gone or not probed: its takes left out). */
export async function lineTakes(line: Line, sentences: Sentence[], cut?: CutSettings): Promise<LineTakes> {
  const db = libraryDb();
  const srcs = new Set(line.takes.map((t) => sentences.find((s) => s.n === t.first)?.src).filter((s): s is string => !!s));
  const sources: Record<string, TimelineSource> = {};
  const words: Record<string, TimedWord[]> = {};
  const energy: Record<string, Float32Array> = {};
  for (const id of srcs) {
    const row = db.prepare("SELECT a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as { title: string; probe: string | null } | undefined;
    const probe = row?.probe ? (JSON.parse(row.probe) as ProbeSummary) : null;
    if (!row || !probe) continue;
    sources[id] = sourceOf(id, row.title, probe);
    words[id] = wordsOf(db, id) ?? [];
    // kept by analyze or a draft; never measured here (that decodes the file)
    energy[id] = await energyOf(id, () => Promise.reject(new Error("not measured"))).catch(() => new Float32Array());
  }
  const fps = Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, s.fps]));
  return { line: line.id, text: line.text, takes: takeCuts(line, sentences, words, energy, fps, cut), sources };
}
