/**
 * An edit as a plan: what the person asked for (the brief, on top of the workspace's own setup) written by their AI as
 * shots on a timeline, then drawn by one renderer through the usual draft → preview → Review chain. The kind of edit is
 * the brief's words, never a fixed list: a hard edit cut to a song, a recap, a trailer, a music video, a tutorial from
 * screen recordings, a visualizer with no footage at all. A new kind of edit needs a different brief, not new code.
 *
 * Built in parts: the index (what the footage and the song hold), generated clips (pictures made from nothing but a
 * style and the sound), the plan step that writes an EditPlan and the renderer that draws it. Times are seconds.
 */

import type { TimelineEvent } from "./library";

/** One stretch of a source between two picture changes, with how much moves in it. */
export interface IndexShot {
  a: number;
  b: number;
  /** 0 still … 1 the most movement in this source */
  motion: number;
  /** what is seen, in a few words, when the AI has looked (contact sheets, or the library's own description); "junk: …"
   * when it shows no action (a map, a menu, loading, dark, mostly the game's buttons) */
  desc?: string;
  /** from the library's shot descriptions (contracts/library.ts Stretch), when the source has them */
  action?: number;
  clear?: boolean;
  tags?: string[];
  /** picture hash of its middle frame: two shots with close hashes show the same picture (shown once in a cut) */
  ph?: string;
  /** why it is no shot, measured: "dark", "flat" (black, a fade, loading), "ui" (a desktop, page or menu), "still" */
  junk?: string;
  /** where its picture changes, across (16 columns) and down (9 rows), as shares of the whole, the HUD left out */
  moves?: { cols: number[]; rows: number[] };
}

export interface IndexSource {
  /** the edit's source id (the library version id), the way EditPlan shots name it */
  id: string;
  title: string;
  dur: number;
  fps: number;
  w: number;
  h: number;
  /** someone speaks in it (its words are the edit's sentences, as before) */
  speech: boolean;
  /** it has a sound stream at all; a shot of one without never plays its own sound */
  sound?: boolean;
  shots: IndexShot[];
  /** the HUD: 16×9 cells (row by row, 1 = HUD) that stay put while the rest of the picture moves */
  hud?: number[];
  /** what happens when, from Gemini watching it with its sound (the library's timeline, api/library/timeline.ts) */
  timeline?: TimelineEvent[];
}

/** A song or any sound to cut to, from `startS` on. */
export interface SongBeats {
  /** the source id or file it was measured from */
  source: string;
  startS: number;
  bpm: number;
  /** every beat, from startS, in the song's own time */
  beats: number[];
  /** the first beat of each bar */
  downbeats: number[];
  /** the hardest hits (drops, snare hits, onsets well above the rest): where the effects land */
  strong: number[];
  /** parts of the song by how loud and busy they are: an intro, a build, a drop */
  sections: Array<{ a: number; b: number; energy: number }>;
}

export interface FootageIndex {
  sources: IndexSource[];
  song?: SongBeats;
  /** what happens across all of it, told from the pictures alone, when the brief needs a story */
  story?: string;
}

/** A clip made from nothing: a style and a length, moving to the sound when `audio` is set (generate.ts). */
export interface GenSpec {
  /** one of the generator's styles (its own list says which), or free words it maps to the nearest */
  style: string;
  seconds: number;
  seed?: number;
  /** colours as #rrggbb, in order of use */
  palette?: string[];
  /** move to this sound (a source id or file), from `audioStartS` */
  audio?: string;
  audioStartS?: number;
  params?: Record<string, number | string>;
}

export type PlanEffect =
  | { type: "punch"; at?: number; amount?: number }
  | { type: "zoom"; at?: number; dur?: number; from?: number; to?: number }
  | { type: "flash"; at?: number; dur?: number; color?: string }
  | { type: "shake"; at?: number; dur?: number; amount?: number }
  | { type: "glitch" | "rgb" | "blur" | "invert" | "strobe"; at?: number; dur?: number; amount?: number }
  /** the whole shot played backwards */
  | { type: "reverse" }
  /** a slice of `dur` from `at` played `amount` times in a row */
  | { type: "stutter"; at?: number; dur?: number; amount?: number }
  /** the picture at `at` held for `dur` */
  | { type: "freeze"; at?: number; dur?: number }
  /** a blur out from the middle, as in a fast push in */
  | { type: "zoomblur"; at?: number; dur?: number; amount?: number };

/**
 * How a shot sits in the frame: fill crops it to the frame (the default); fit shows the whole picture on black; blur
 * shows it whole over a blurred copy of itself; letterbox is a widescreen band; inset is a smaller picture over the
 * shot before it.
 */
export type PlanFrame = "fill" | "fit" | "blur" | "letterbox" | "inset";

/** A crop window's place in the room the picture leaves it: x 0 left … 1 right, y 0 top … 1 bottom (0.5 centred). */
export interface Focus {
  x: number;
  y: number;
}

export interface PlanShot {
  /** where it starts on the timeline */
  at: number;
  dur: number;
  /** a source from the index, from `inS`; or a generated clip */
  src: { source: string; inS: number } | { generate: GenSpec };
  /** 1 = as filmed; a ramp is speed over the shot's own time, from 0 to dur */
  speed?: number;
  ramp?: Array<{ t: number; speed: number }>;
  /** effect times are inside the shot, from 0 */
  fx?: PlanEffect[];
  /** how it comes in from the shot before */
  enter?: "cut" | "flash" | "whip" | "dissolve";
  /** how it sits in the frame (fill when left out) */
  frame?: PlanFrame;
  /** an inset's share of the frame's width, 0.3-0.9 */
  scale?: number;
  /** 1-2 more pictures stacked in a column with this one (2-3 in all), each from `inS` of its source */
  split?: Array<{ source: string; inS: number; focus?: Focus }>;
  /** where the picture's crop sits, set by code from where it moves (fill, letterbox and split crop it) */
  focus?: Focus;
  /** the shot's own sound: off, under the lead, or as it is */
  sound?: "off" | "under" | "full";
  /** what made the AI pick it, in a few words (shown in Review) */
  why?: string;
}

export interface PlanText {
  at: number;
  dur: number;
  text: string;
  /** a design system's text style by name, else the renderer's own */
  style?: string;
  place?: "top" | "middle" | "bottom";
}

export interface EditPlan {
  /** the brief's own words for what this is: "hard edit", "chill recap", "music video" */
  kind: string;
  w: number;
  h: number;
  fps: number;
  /** what you hear first: a voice (the speech-led cut, unchanged), a song, or the sources' own sound */
  lead: { type: "voice" } | { type: "song"; source: string; startS: number; gainDb?: number } | { type: "sources" };
  shots: PlanShot[];
  texts?: PlanText[];
  /** for a batch: what makes this one different from the others ("faster cuts, red palette, hook first") */
  variation?: string;
}

/**
 * What footage a cut was made from (tasks/flywheel/PLAN.md D7): said with a draft only when something was left out,
 * so a cut from part of the footage is never presented as made from all of it.
 */
export interface Coverage {
  /** the footage files the edit had, and their minutes */
  files: number;
  minutes: number;
  /** the files the shot list could pick from, and their minutes */
  pooled: number;
  pooledMinutes: number;
  /** the files the cut uses */
  used: number;
  /** each file left out, and why in plain words ("the face check found a face", "still being described") */
  left: { title: string; why: string }[];
}

/**
 * The look at a rendered cut before the person sees it (tasks/flywheel/PLAN.md stage 4): one judgement against the
 * brief, the person's notes and the editing style. `fails` names the shots (by place in the cut, from 1) that don't
 * hold up and why; Review shows them only when there are any.
 */
export interface Critique {
  ok: boolean;
  fails: { n: number; why: string }[];
  /** 1: the first cut; 2: after the one fix round */
  round: number;
}
