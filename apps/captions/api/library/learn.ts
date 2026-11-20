import type { DatabaseSync } from "node:sqlite";
import { aiFor, completeWithFallback, onApiKey } from "../ai-complete";
import { emitEvent } from "../lib/events";
import { parseJsonObject } from "../lib/instagram/vision";
import { workspaceContext } from "../lib/workshop/context";
import { libraryDb } from "./db";
import { libraryWorkspaceId, WORKSPACE_MAX, whoFor } from "./describe";
import { RULE } from "./look";
import { indexAsset } from "./query";

/**
 * Learning from the person's own tags (owner, 2026-11-17: "it also looks at my tags and figures out why I added them
 * and maybe it can make new connections"). When someone gives clips a tag, their own AI reads what those clips show
 * and writes one line on how to recognise it (tag_notes). Every description and shot description then reads those lines
 * with the workspace's context (describe.ts notesBlock), and the AI gives the tag, marked as its own, to the library's
 * other clips that show it (suggest): the person keeps it or takes it off, and one taken off never comes back to that
 * clip (tag_rejections). Describing the library again learns every tag first (learnAll), so the first pass already knows.
 */

export const LEARN_LABEL = "Media Library tags";
/** Most of a tag's clips its line is learned from. */
const LEARN_FROM = 12;
/** Most clips one suggestion call reads. ponytail: the library's newest; nearest by picture vectors when libraries outgrow it */
const SUGGEST_FROM = 60;
/** Characters of a clip's description either call reads. */
const TEXT = 360;

type Row = { id: string; title: string; text: string | null };

/** A clip as a numbered line: its title and what it shows. */
const line = (r: Row, i: number) => `[${i + 1}] ${r.title}: ${(r.text ?? "").replace(/\s+/g, " ").slice(0, TEXT) || "no description"}`;

/** What a clip shows: the person's description first, else the AI's. */
const SHOWS = `COALESCE(
  (SELECT text FROM descriptions WHERE version_id = a.current_version_id AND source = 'user'),
  (SELECT text FROM descriptions WHERE version_id = a.current_version_id AND source = 'ai'))`;

/** The person's route for these calls (their own key first, as describing goes), or null when they have no AI. */
function routeFor(actor: string) {
  const r = onApiKey(actor, "library", LEARN_LABEL) || aiFor(whoFor(actor), "library", LEARN_LABEL);
  if (r.off) return null;
  return r.only?.includes("mac") ? { ...r, mac: { ...r.mac, background: true } } : r;
}

export function parseNote(text: string): { note: string; seen: boolean } {
  const o = parseJsonObject(text);
  const note = typeof o.note === "string" ? o.note.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (!note) throw new Error("The AI returned no line");
  return { note, seen: o.seen !== false };
}

export function parseYes(text: string, n: number): number[] {
  const o = parseJsonObject(text);
  return Array.isArray(o.yes) ? [...new Set(o.yes.filter((x): x is number => Number.isInteger(x) && x >= 1 && x <= n))] : [];
}

/**
 * Learns (again) how to recognise `tag` from the library's clips the person gave it, when that set changed since the
 * line was written; then suggests it on the others. A tag no clip has from the person any more loses its line. True when
 * a line was written.
 */
export async function learnTag(db: DatabaseSync, libraryId: string, tag: string, actor: string): Promise<boolean> {
  const rows = db
    .prepare(
      `SELECT a.id, a.title, ${SHOWS} AS text FROM asset_tags t JOIN assets a ON a.id = t.asset_id
       WHERE a.library_id = ? AND lower(t.tag) = lower(?) AND t.source = 'user' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL ORDER BY a.id LIMIT ${LEARN_FROM}`,
    )
    .all(libraryId, tag) as Row[];
  if (!rows.length) {
    db.prepare("DELETE FROM tag_notes WHERE library_id = ? AND lower(tag) = lower(?)").run(libraryId, tag);
    return false;
  }
  const clips = rows.map((r) => r.id).join(",");
  const had = db.prepare("SELECT clips FROM tag_notes WHERE library_id = ? AND lower(tag) = lower(?)").get(libraryId, tag) as { clips: string } | undefined;
  if (had?.clips === clips) return false;
  const route = routeFor(actor);
  if (!route) return false;
  const ws = await libraryWorkspaceId(db, libraryId);
  const workspace = ws ? await workspaceContext(ws, WORKSPACE_MAX) : "";
  const system = `You work out what a creator means by one of their own tags in their media library, so other clips can be tagged the same way. ${RULE} Answer with JSON only.`;
  const user = [
    ...(workspace ? [`The workspace the library belongs to:\n${workspace}`] : []),
    `The person tagged ${rows.length === 1 ? "this clip" : `these ${rows.length} clips`} "${tag}". What each one shows:\n${rows.map(line).join("\n")}`,
    `Write one line on what tells that a clip is "${tag}": what is seen or heard in it (a place, a thing, an effect, a screen, a kind of shot), in plain words someone could check against a picture, ` +
      `using the workspace's own names. Only what these clips share. If the tag names something no picture shows (a rating, a plan, a use), say what it seems to mean and set "seen" to false.`,
    `Answer as {"note": "one line", "seen": true}`,
  ].join("\n\n");
  const { note, seen } = await completeWithFallback(system, user, undefined, parseNote, route);
  db.prepare("DELETE FROM tag_notes WHERE library_id = ? AND lower(tag) = lower(?)").run(libraryId, tag);
  db.prepare("INSERT INTO tag_notes (library_id, tag, note, seen, clips, made_at) VALUES (?, ?, ?, ?, ?, ?)").run(libraryId, tag, note, seen ? 1 : 0, clips, Date.now());
  if (seen) await suggestTag(db, libraryId, tag, note, actor);
  return true;
}

/**
 * Gives `tag` (as the AI's) to the library's clips whose description shows what its line says, of the ones that don't
 * have it and never had it taken off. Returns how many it tagged.
 */
export async function suggestTag(db: DatabaseSync, libraryId: string, tag: string, note: string, actor: string): Promise<number> {
  const rows = db
    .prepare(
      `SELECT a.id, a.title, ${SHOWS} AS text FROM assets a
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND a.kind IN ('video', 'image') AND ${SHOWS} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND lower(t.tag) = lower(?))
         AND NOT EXISTS (SELECT 1 FROM tag_rejections r WHERE r.asset_id = a.id AND lower(r.tag) = lower(?))
       ORDER BY a.created_at DESC LIMIT ${SUGGEST_FROM}`,
    )
    .all(libraryId, tag, tag) as Row[];
  if (!rows.length) return 0;
  const route = routeFor(actor);
  if (!route) return 0;
  const system = `You find the clips in a creator's media library that show one thing. ${RULE} Answer with JSON only.`;
  const user = [
    `The tag "${tag}": ${note}`,
    `Clips in the library without it:\n${rows.map(line).join("\n")}`,
    `Which of these clearly show "${tag}" by what their description says? Only clear matches; none is fine. Answer as {"yes": [clip numbers]}`,
  ].join("\n\n");
  const yes = await completeWithFallback(system, user, undefined, (t) => parseYes(t, rows.length), route);
  const add = db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')");
  for (const n of yes) {
    const id = rows[n - 1]!.id;
    add.run(id, tag);
    indexAsset(db, id);
  }
  if (yes.length) emitEvent("library.changed", {});
  return yes.length;
}

/** Learns every tag the person gave clips in the library whose clips changed since (learnTag), three at a time. */
export async function learnAll(db: DatabaseSync, libraryId: string, actor: string): Promise<number> {
  const tags = [
    ...new Set(
      [
        ...(db.prepare("SELECT DISTINCT t.tag FROM asset_tags t JOIN assets a ON a.id = t.asset_id WHERE a.library_id = ? AND t.source = 'user' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL").all(libraryId) as { tag: string }[]),
        ...(db.prepare("SELECT tag FROM tag_notes WHERE library_id = ?").all(libraryId) as { tag: string }[]),
      ].map((r) => r.tag),
    ),
  ];
  let learned = 0;
  for (let i = 0; i < tags.length; i += 3)
    learned += (await Promise.all(tags.slice(i, i + 3).map((t) => learnTag(db, libraryId, t, actor).catch(() => false)))).filter(Boolean).length;
  return learned;
}

const soon = new Map<string, ReturnType<typeof setTimeout>>();

/** Learns these tags a few seconds after the person's last change to them, in the background (a burst of edits is one call). */
export function learnSoon(libraryId: string, tags: string[], actor: string, wait = 3000): void {
  for (const tag of tags) {
    const key = `${libraryId}\0${tag.toLowerCase()}`;
    clearTimeout(soon.get(key));
    soon.set(
      key,
      setTimeout(() => {
        soon.delete(key);
        void learnTag(libraryDb(), libraryId, tag, actor).catch(() => {});
      }, wait),
    );
  }
}
