import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CARDS_DRAW_KIND, type CardsDraw } from "../../../contracts/devices";
import { libraryDb } from "../../library/db";
import { cardFile, readCards, scriptFile, STILLS } from "./state";

/**
 * The server's side of a `cards-draw` step (contracts/devices.ts): what the Mac that holds the step is to draw, and
 * what it sends back. Both ask for the step by its job id and answer only the device that claimed it and still holds
 * it, so a draw taken back takes nothing more. What a Mac sends lands beside the cards as the draw that is out; the
 * card step takes it up when the draw ends (step.ts).
 */

/** A clip is a few megabytes at most (about 1 MB for 2.4 s of 1080 × 1920); the request's own cap is 50 MB. */
const CLIP_MAX = 40 * 1024 * 1024;
const STILL_MAX = 5 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * Whether a draw failed because the script threw on a card: the Mac's sentence says so in its own words (CardJobs.swift
 * `cardFailure`, "Card 2 of 4 has a script that failed (…)."). Drawn again, the same script throws the same way.
 */
export const scriptThrew = (why: string | null | undefined) => /\bCard \d+ of \d+ has a script that failed \(/.test(why ?? "");

/** The cards-draw step this device holds, as its edit and version; null when it holds no such step. */
function held(device: string, job: number): { editId: string; variant: string } | null {
  const row = libraryDb().prepare("SELECT version_id FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running' AND kind = ?").get(job, device, CARDS_DRAW_KIND) as
    | { version_id: string }
    | undefined;
  if (!row) return null;
  const cut = row.version_id.indexOf(":");
  return { editId: row.version_id.slice(0, cut), variant: row.version_id.slice(cut + 1) };
}

/** GET …/job/:id/cards: the script and the cards to draw. */
export function cardsDraw(device: string, job: number): CardsDraw | null {
  const at = held(device, job);
  const st = at && readCards(at.editId, at.variant);
  if (!at || !st?.cards?.length || !st.width || !st.height || !st.fps) return null;
  let script: string;
  try {
    script = readFileSync(scriptFile(at.editId, at.variant), "utf8");
  } catch {
    return null;
  }
  return {
    width: st.width,
    height: st.height,
    fps: st.fps,
    script,
    cards: st.cards.map((c) => ({ id: c.id, seconds: c.seconds, content: { id: c.id, text: c.text, line: c.line } })),
  };
}

/**
 * POST …/job/:id/cards/:cardId: one card's clip and its three stills (first, middle, last). The id must be a card of
 * the plan: it names the files, and nothing else of the request does. A card sent again (a draw tried again draws
 * every card again) replaces the one before.
 * Returns what is wrong, or null when it was kept; "Not found" when the device holds no such step or card.
 */
export async function saveCard(device: string, job: number, cardId: string, clip: unknown, stills: unknown): Promise<string | null> {
  const at = held(device, job);
  const card = at && readCards(at.editId, at.variant)?.cards?.find((c) => c.id === cardId);
  if (!at || !card) return "Not found";
  const three = [stills].flat();
  if (!(clip instanceof File) || three.length !== STILLS.length || !three.every((s): s is File => s instanceof File)) return "Send clip, and still three times";
  if (!clip.size || clip.size > CLIP_MAX || three.some((s) => !s.size || s.size > STILL_MAX)) return "A file is empty or too big";
  const film = Buffer.from(await clip.arrayBuffer());
  const pictures = await Promise.all(three.map(async (s) => Buffer.from(await s.arrayBuffer())));
  if (film.subarray(4, 8).toString("latin1") !== "ftyp") return "clip is not an mp4";
  if (!pictures.every((p) => p.subarray(0, 4).equals(PNG))) return "A still is not a PNG";
  const file = cardFile(at.editId, at.variant, card.id, undefined, true)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, film);
  for (const [k, s] of STILLS.entries()) await writeFile(cardFile(at.editId, at.variant, card.id, s, true)!, pictures[k]!);
  return null;
}
