import { parseJsonObject } from "../../lib/instagram/vision";
import { CARD_TEXT_MAX, MAX_CARDS, SCRIPT_MAX, type PlannedCard } from "./state";

/**
 * The three questions the card step asks the person's AI, and how each answer is read. They are the task and the
 * answer's shape: the look comes only from the person's own brief and pictures. Each is asked to answer and nothing
 * else: a call carries no tool, no folder beyond its own pictures and no web (step.ts, answer-only.test.ts).
 */

/** One line of the version, as spoken; `ok`: a card fits over it. */
export interface PlanLine {
  n: number;
  text: string;
  ok: boolean;
}

const PLAN = `You pick the moments of a short video that get an animated card: a few words on screen, filling the frame for about two seconds while the speaker's voice goes on. You are given the video's lines as spoken, in order, and the look the author wants, in the author's own words.

Pick at most ${MAX_CARDS} of the lines marked *, the ones where words on screen help a viewer most. Fewer is fine, and none is fine. For each, write the card's words: at most ${CARD_TEXT_MAX} characters, the speaker's own point in the speaker's own words.

Answer with JSON only, in this shape:
{"cards":[{"line":2,"text":"the card's words"}]}`;

const look = (brief: string) => `The look, in the author's own words:\n${brief.trim() || "(none)"}`;

/** `packText`: the installed packs' instructions for editor.cards (api/lib/packs.ts), added after the app's own text, as the script step adds its own. */
export function planPrompt(i: { lines: PlanLine[]; brief: string; packText?: string }): { system: string; user: string } {
  const lines = i.lines.map((l) => `${l.n}${l.ok ? "*" : ""} ${l.text}`).join("\n");
  return { system: i.packText ? `${PLAN}\n\n${i.packText}` : PLAN, user: `${look(i.brief)}\n\nThe lines (a line marked * can carry a card):\n${lines}` };
}

/** The plan's cards, checked: a line that can carry one, each line once, words cut to the cap, at most MAX_CARDS. */
export function parsePlan(text: string, lines: PlanLine[]): { line: number; text: string }[] {
  const o = parseJsonObject(text);
  if (!Array.isArray(o.cards)) throw new Error("The AI's answer has no list of cards");
  const out: { line: number; text: string }[] = [];
  for (const c of o.cards as { line?: unknown; text?: unknown }[]) {
    const line = Number(c?.line);
    const words = typeof c?.text === "string" ? c.text.replace(/\s+/g, " ").trim().slice(0, CARD_TEXT_MAX).trim() : "";
    if (!words || !lines.some((l) => l.n === line && l.ok) || out.some((x) => x.line === line)) continue;
    if (out.push({ line, text: words }) === MAX_CARDS) break;
  }
  return out;
}

/** What a card's script is and what it has: the drawing page of the Mac app, said once for the make and the look call. */
const stage = (w: number, h: number) => `The script runs alone in an empty web page. It must define one function, kitFrame(t, card), which paints the whole frame for time t (seconds from the card's start) into the element with the id "stage". A picture of the stage is taken right after each call returns, so nothing may wait: no timers, no CSS transitions or animations, nothing still loading. Work every position, size and opacity out from t.

The stage is ${w} by ${h} CSS pixels, black, with white text until the script says otherwise; what the script leaves unpainted is black in the video. The script has the DOM, CSS, SVG, a 2D canvas and the system's fonts. Pictures only as data: addresses written into the script. Nothing can be loaded by address, and there is no WebGL, WebAssembly or audio. One card's frames must all draw within 20 seconds.

card is {"id":"c1","text":"the words on the card","line":"what the speaker says under it"}; how long each card shows is in the list of cards, by its id. A card fills the frame for that long and is cut in and out with the video: it arrives fast, holds long enough to read on a phone, and is never empty at its first, middle or last frame. The script is at most ${SCRIPT_MAX} characters.`;

const MAKE = `You write the drawing code for the animated cards of one short video: one script that draws every card, in the look the author describes and shows.`;
const CODE_ONLY = `Answer with the script only: plain JavaScript, no Markdown and no explanation.`;

export interface FrameInput {
  brief: string;
  width: number;
  height: number;
  fps: number;
  cards: PlannedCard[];
}

const frame = (i: FrameInput) =>
  `The frame: ${i.width} by ${i.height} pixels, ${i.fps} frames a second.\n\nThe cards:\n${i.cards.map((c) => `${c.id} (${c.seconds.toFixed(1)} s): ${JSON.stringify(c.text)} over the line ${JSON.stringify(c.line)}`).join("\n")}`;

/** `made` and `inspirations`: how many of each the call carries as pictures, the made ones first. */
export function makePrompt(i: FrameInput & { made: number; inspirations: number }): { system: string; user: string } {
  const range = (from: number, n: number) => (n === 1 ? `Picture ${from}` : `Pictures ${from} to ${from + n - 1}`);
  const pictures = [
    i.made ? `${range(1, i.made)}: stills of cards the author liked in earlier videos.` : "",
    i.inspirations ? `${range(i.made + 1, i.inspirations)}: inspirations the author collected.` : "",
  ].filter(Boolean);
  const shown = pictures.length ? `\n\n${pictures.join(" ")} They show the look, not the words.` : "";
  return { system: `${MAKE}\n\n${stage(i.width, i.height)}\n\n${CODE_ONLY}`, user: `${look(i.brief)}${shown}\n\n${frame(i)}` };
}

/** The script out of an answer: a code fence around it is dropped. Throws when it is no card script or over the cap. */
export function parseScript(text: string): string {
  const script = text.trim().replace(/^```[a-z]*\s*\n/i, "").replace(/\n```$/, "").trim();
  if (!/\bkitFrame\b/.test(script)) throw new Error("The AI's answer is not a card script");
  if (script.length > SCRIPT_MAX) throw new Error(`The AI's card script is over ${SCRIPT_MAX.toLocaleString("en-US")} characters`);
  return script;
}

const LOOK = `You check the animated cards of one short video. You are given the script that drew them, one sheet with three stills of every card (its first, middle and last frame) and pictures of the look the author wants.

Look for what a viewer would see as broken: words cut off or outside the frame, words too small to read on a phone, an empty frame, text over text, a look far from the author's words and pictures. Taste alone is no reason to change a card.

If the cards are fine, answer with the two letters OK and nothing else. If not, answer with the whole corrected script only: plain JavaScript, no Markdown and no explanation.`;

/** `columns`: the sheet has one card in each column (first, middle and last frame from the top); else one card in each row. `pictures`: how many of the author's follow the sheet. */
export function lookPrompt(i: FrameInput & { script: string; columns: boolean; pictures: number }): { system: string; user: string } {
  const sheet = `The first picture is the sheet: one card in each ${i.columns ? "column, in the cards' order from the left, its first, middle and last frame from the top" : "row, in the cards' order from the top, its first, middle and last frame from the left"}.`;
  const theirs = i.pictures ? ` The ${i.pictures === 1 ? "other picture is" : `other ${i.pictures} are`} the author's: the look.` : "";
  return { system: `${LOOK}\n\n${stage(i.width, i.height)}`, user: `${look(i.brief)}\n\n${sheet}${theirs}\n\n${frame(i)}\n\nThe script:\n${i.script}` };
}

/** Null: the cards are fine. Else the corrected script. An answer that is neither counts as fine. */
export function parseLook(text: string): string | null {
  if (!/\bkitFrame\b/.test(text)) return null;
  return parseScript(text);
}
