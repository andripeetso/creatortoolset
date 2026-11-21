import type { FootageIndex } from "../../contracts/edit-plan";
import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import type { ProbeSummary } from "../library/media/probe";
import { libraryDb } from "../library/db";
import { songFor } from "./plan";
import { librarySounds, placeSfx, SFX_DB, type SfxMoment, type SfxSound } from "./sfx";
import type { EditMeta } from "./store";
import { sourceOf } from "./timeline";

/**
 * The sound of a cut around speech (the sound step, voice-mix.ts): a music bed under the voice on A2 and sound effects on
 * the B-roll and the cards on A3, from the edit's own Media Library, as a planned edit gets them (plan.ts). Laid once per
 * draft: what the person changes on A2 or A3 by hand afterwards is theirs (the notes below mark what was laid).
 */

/** Notes this file writes start with these: a draft that has one got that part already. */
export const MUSIC_NOTE = "Sound: music bed";
export const SFX_NOTE = "Sound: sound effects";

/**
 * The bed's level under the voice. shortcut: a fixed gain for a mastered song (about -9 LUFS, so the bed sits near
 * -31 LUFS, 15 LU under the voice); measure the song (work/tasks/loudness.ts) when a quiet song comes out too low.
 */
export const BED_DB = -22;
/** Seconds the bed fades out over at the cut's end. */
const BED_FADE_S = 1.5;

/** The brief asks for music under the voice in so many words ("no music" is not asking). */
export const asksMusic = (brief: string) => /\b(music|song|soundtrack|backing track)\b/i.test(brief) && !/\b(no|without|not? any)\s+(\w+\s+)?(music|song|soundtrack)/i.test(brief);

/**
 * The bed for a cut around speech: the song the edit names, a song among its sources, the library's song whose title the
 * brief names, else, only when the brief asks for music, the library's newest song. None: no bed (never one unasked).
 */
export function bedSong(edit: EditMeta): { id: string; title: string; src: TimelineSource } | null {
  // songFor's index stands in for footage where someone speaks: it then never falls back to the newest song itself
  const speaking = { sources: edit.sources.map((id) => ({ id, speech: true })) } as unknown as FootageIndex;
  const song = songFor(edit, speaking) ?? (asksMusic(edit.brief) ? songFor(edit, { sources: [] } as unknown as FootageIndex) : null);
  if (!song) return null;
  const r = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?").get(song.id) as { probe: string | null } | undefined;
  return r?.probe ? { id: song.id, title: song.title, src: sourceOf(song.id, song.title, JSON.parse(r.probe) as ProbeSummary) } : null;
}

/** The cut's length in its frames: the end of its last item on any track. */
export const cutEnd = (tl: Timeline): number => Math.max(0, ...Object.values(tl.tracks).flatMap((t) => t.items.map((i) => i.rec + i.len)));

/**
 * The moments sound effects mark on a cut around speech: a whoosh where a run of B-roll comes in and where it leaves (not
 * at the very start or end), and a pop where a card comes in. Cards are the edit's own clips (TimelineSource.file).
 */
export function cutMoments(tl: Timeline): SfxMoment[] {
  const fps = tl.fps;
  const end = cutEnd(tl);
  const out: SfxMoment[] = [];
  const v2 = tl.tracks.V2.items.filter((i) => i.enabled !== false).sort((a, b) => a.rec - b.rec);
  let run: { a: number; b: number } | null = null;
  const close = () => {
    if (!run) return;
    if (run.a > 0) out.push({ at: run.a / fps, prio: 2, types: ["whoosh", "swipe"] });
    if (run.b < end) out.push({ at: run.b / fps, prio: 2, types: ["whoosh", "swipe"] });
  };
  for (const i of v2) {
    if (tl.sources[i.src]?.file) {
      out.push({ at: i.rec / fps, prio: 3, types: ["pop", "click", "ding"] });
      continue;
    }
    // two cutaways a frame or two apart are one run
    if (run && i.rec <= run.b + 2) run.b = Math.max(run.b, i.rec + i.len);
    else {
      close();
      run = { a: i.rec, b: i.rec + i.len };
    }
  }
  close();
  return out.sort((a, b) => a.at - b.at);
}

/** The bed on A2 from the song's start, as long as the cut (or the song), fading out at the end. */
export function layBed(tl: Timeline, song: TimelineSource): Timeline {
  const end = cutEnd(tl);
  const len = Math.min(end, Math.floor((song.dur / song.fps) * tl.fps));
  if (len <= 0) return tl;
  const bed: Item = { src: song.versionId, in: 0, len, rec: 0, gainDb: BED_DB, fade_out: Math.min(len, Math.round(BED_FADE_S * tl.fps)) };
  return { ...tl, sources: { ...tl.sources, [song.versionId]: song }, tracks: { ...tl.tracks, A2: { ...tl.tracks.A2, items: [bed] } } };
}

/** Sound effects on A3 at the cut's moments (placeSfx's spacing and variety), at SFX_DB under the voice. */
export function laySfx(tl: Timeline, sounds: SfxSound[]): Timeline {
  const placed = placeSfx(cutMoments(tl), sounds, tl.fps, cutEnd(tl));
  if (!placed.length) return tl;
  const sources = { ...tl.sources };
  for (const p of placed) sources[p.sound.versionId] = p.sound;
  const items = placed.map((p): Item => ({ src: p.sound.versionId, in: 0, len: p.len, rec: p.rec, gainDb: SFX_DB }));
  return { ...tl, sources, tracks: { ...tl.tracks, A3: { ...tl.tracks.A3, items } } };
}

/**
 * A draft's bed and sound effects, each laid once: music when the edit asks for it (bedSong) and A2 is empty, sound effects
 * when its set is the library's and there is B-roll or a card to mark and A3 is empty. Returns the draft unchanged when
 * nothing was laid. A planned cut has its own (plan.ts).
 */
export function laySound(edit: EditMeta, d: { timeline: Timeline; notes: string[] }): { timeline: Timeline; notes: string[] } {
  if (d.timeline.plan || edit.plan) return d;
  let { timeline } = d;
  const notes = [...d.notes];
  if (!timeline.tracks.A2.items.length && !notes.some((n) => n.startsWith(MUSIC_NOTE))) {
    const song = bedSong(edit);
    if (song) {
      timeline = layBed(timeline, song.src);
      if (timeline.tracks.A2.items.length) notes.push(`${MUSIC_NOTE}: ${song.title}, under the voice`);
    }
  }
  if (edit.bundle.sfxSet === "library" && !timeline.tracks.A3.items.length && !notes.some((n) => n.startsWith(SFX_NOTE)) && cutMoments(timeline).length) {
    const lib = (libraryDb().prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(edit.sources[0] ?? "") as { library_id: string } | undefined)?.library_id;
    const laid = lib ? laySfx(timeline, librarySounds(lib)) : timeline;
    if (laid.tracks.A3.items.length) {
      timeline = laid;
      notes.push(`${SFX_NOTE}: ${laid.tracks.A3.items.length} on the B-roll and cards`);
    }
  }
  return timeline === d.timeline ? d : { timeline, notes };
}
