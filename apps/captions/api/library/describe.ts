import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { aiFor, onApiKey } from "../ai-complete";
import { BACKGROUND_SLOTS } from "../lib/mac-claude";
import { completeVisionWithFallback } from "../ai-vision";
import { parseJsonObject } from "../lib/instagram/vision";
import { findUser, listUsers, LOCAL_USER, type SessionUser } from "../users";
import { projectOf } from "../lib/project-of";
import { stampOf, workspaceContext } from "../lib/workshop/context";
import { homeOf } from "./access";
import { transcriptExcerpt } from "./attach";
import { RULE } from "./look";
import { ffmpegTo } from "./media/run";
import { indexAsset } from "./query";
import { NeedsKey, segmentsOf } from "./transcribe";
import { isAdminActor } from "../my-keys";
import type { Roll } from "./roll";
import { fileInto, MAX_AI_FOLDERS, plainFolders, toFile } from "./organize";
import { asTurn, turned, turnVersion } from "./turn";

/**
 * The library's `describe` job (tasks/media-library-plan.md, sections 5 and 11): four frames, the title and a
 * transcript excerpt go to the actor's own AI (aiFor: their provider, or their own Anthropic key).
 * No route parks the job as needs_key, never failed and never on someone else's AI. The answer is JSON: a description
 * and tags, stored as the AI's, and in the same answer whether the clip is A-roll or B-roll (roll.ts reads it) and what
 * kind of footage it is in a few plain words (descriptions.kind: the footage profile, lib/workshop/context.ts, counts
 * by it; code decides on `roll`, never on `kind`). The description keeps the stamp of the workspace context it was
 * written under (contextStamp). A human's description stays the one shown (query.ts); human tags keep their source.
 * On unless the library's owner switched it off (settings.describe; db.ts SETTING_DEFAULTS): a big upload says first what it spends.
 */

export const FRAMES = 4;
/** What the usage tally counts a description as: estimate.ts reads its average cost back. */
export const DESCRIBE_LABEL = "Media Library describe";
/** The describe prompt's version, in its context stamp: a change to the prompt that should describe clips again bumps it. */
export const DESCRIBE_VERSION = "describe-2";
const MAX_TAGS = 6;
/** Most of the library's tags a description is shown, most used first. */
const VOCABULARY = 60;

/**
 * What a tag is for: finding this clip among the library's others. Specific things in the workspace's own names, the
 * library's spelling reused, nothing every clip shares (owner, 2026-11-15: "smart tags … adapted from the full context
 * of the media", after a sidebar of "grass field", "cobblestone", "fantasy" and "screen recording 12").
 */
const TAG_RULE =
  "tags are the words someone would search to find this clip among the others in the library: what sets it apart. " +
  "Name the specific thing it shows in the workspace's own words when it has them (a place, a mode, a feature, an event, a product, a kind of shot). " +
  "Never tag what nearly every clip here shares or the workspace's general subject (its genre, the medium, \"gameplay\", \"screen recording\"), " +
  "and never colours, textures, light, mood or words that only describe the look. " +
  "Use a tag from the library's list, spelled the same, when it means the same thing; add a new one only for what the list lacks. " +
  "Lowercase, one to three words each. Fewer good tags beat many; none is fine.";

/** Everything the prompt is built from. There is no field for who is in the clip: no names, no ages. */
export interface DescribeInput {
  title: string;
  transcript?: string;
  frames: number;
  /** the workspace the clip is in (its instructions: what the brand, product or game is), so the AI can name what it sees */
  workspace?: string;
  /** the library's plain folders, when the AI organizes it (organize.ts): the answer names the one the clip fits */
  folders?: string[];
  /** with folders: the answer may name a new folder (the library has fewer than MAX_AI_FOLDERS) */
  newFolder?: boolean;
  /** the library's tags (tagsOf) so the answer reuses its words */
  tags?: { clips: number; list: { tag: string; count: number }[] };
}

/** The tags on the library's other clips (not in the trash), most used first, and how many clips it has. */
export function tagsOf(db: DatabaseSync, versionId: string): NonNullable<DescribeInput["tags"]> {
  const of = "SELECT a.library_id AS lib, a.id AS asset FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?";
  const at = db.prepare(of).get(versionId) as { lib: string; asset: string } | undefined;
  if (!at) return { clips: 0, list: [] };
  const { clips } = db.prepare("SELECT COUNT(*) AS clips FROM assets WHERE library_id = ? AND trashed_at IS NULL").get(at.lib) as { clips: number };
  const list = db
    .prepare(
      `SELECT t.tag, COUNT(*) AS count FROM asset_tags t JOIN assets a ON a.id = t.asset_id
       WHERE a.library_id = ? AND a.id <> ? AND a.trashed_at IS NULL GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT ${VOCABULARY}`,
    )
    .all(at.lib, at.asset) as { tag: string; count: number }[];
  return { clips, list };
}

export interface Described {
  description: string;
  tags: string[];
  /** "a": someone talks to the camera through most of it; "b": anything else. Absent when the answer had none */
  roll?: Roll;
  /** the folder it fits, of the ones it was given (or none) */
  folder?: string;
  /** what the footage is, in one to three plain words ("gameplay", "screen recording", "talking head") */
  kind?: string;
  /** clockwise degrees the frames need to stand upright (a phone filmed sideways, a screen recorded on its side); absent = upright */
  turn?: 90 | 180 | 270;
}

export function describePrompt(input: DescribeInput): { system: string; user: string } {
  return {
    system:
      "You describe one clip in a creator's media library so they can find it later by searching. Say what is seen and heard: " +
      `the setting, what happens, objects, shot type and mood. ${RULE} Answer with JSON only.`,
    user: [
      ...(input.workspace
        ? [`The workspace this clip belongs to. Use it to name what is seen (the product, the game, its places and features) when the frames show it; never add what they don't show:\n${input.workspace}`]
        : []),
      `Title: ${input.title}`,
      input.transcript ? `What is said (excerpt):\n${input.transcript}` : "Nothing is transcribed.",
      input.frames > 1 ? `The ${input.frames} pictures are frames from the start to the end of the clip, in order.` : "The picture is the whole clip: a photo, or a clip too short for more.",
      'turn is how many degrees clockwise the pictures must be turned to stand upright: 0 when they already are; 90, 180 or 270 only when clearly sideways or upside down (writing, a game\'s or an app\'s screen, the horizon, people standing or sitting all read on their side).',
      'roll is "a" when a person talks to the camera (or to someone just beside it) through most of the clip, a take a video could be built on; else "b" (scenery, action, details, people not talking to the camera).',
      ...(input.folders
        ? [
            input.newFolder
              ? `folder is where this clip is filed in the library, judged by what the footage is (gameplay, an interview, a product, a place…). ${input.folders.length ? `Use one of these folders when it fits: ${JSON.stringify(input.folders)}. Otherwise name` : "Name"} a new folder: one to three words, by what the footage is (for example "Gameplay", "Interviews", "Product shots", "Travel"), never a vague name like "Misc", "Other", "Clips" or "B-roll".`
              : `folder is the one of these folders the clip fits best: ${JSON.stringify(input.folders)}`,
          ]
        : []),
      TAG_RULE,
      ...(input.tags?.list.length
        ? [`Tags already in this library of ${input.tags.clips} clips (tag: clips it is on): ${input.tags.list.map((t) => `${t.tag}: ${t.count}`).join(", ")}`]
        : []),
      `Answer as {"description": "two or three plain sentences", "tags": ["up to ${MAX_TAGS} tags"], "roll": "a" or "b", "turn": 0, ${KIND_ANSWER}${input.folders ? ', "folder": "a folder name"' : ""}}`,
    ].join("\n\n"),
  };
}

const KIND_ANSWER = '"kind": "what the footage is, in one to three plain lowercase words, for example gameplay, screen recording, talking head, product close-ups, drone footage"';

/** One to three plain words, lowercase; anything longer or odd is no kind. */
const kindOf = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const k = v.trim().toLowerCase().replace(/\s+/g, " ");
  return k && k.length <= 40 && k.split(" ").length <= 3 && /^[\p{L}\p{N} '&/-]+$/u.test(k) ? k : undefined;
};

/** The answer's description and tags; any other key the model adds is dropped. */
export function parseDescribe(text: string): Described {
  const o = parseJsonObject(text);
  const description = typeof o.description === "string" ? o.description.trim().slice(0, 1000) : "";
  if (!description) throw new Error("The AI returned no description");
  const tags = Array.isArray(o.tags)
    ? [...new Set(o.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS)
    : [];
  const folder = typeof o.folder === "string" ? o.folder.trim() : "";
  const kind = kindOf(o.kind);
  const turn = typeof o.turn === "number" ? asTurn(o.turn) : 0;
  return { description, tags, ...(o.roll === "a" || o.roll === "b" ? { roll: o.roll } : {}), ...(folder ? { folder } : {}), ...(turn ? { turn } : {}), ...(kind ? { kind } : {}) };
}

/** Most of the workspace's context a description carries: it rides every clip's call. */
export const WORKSPACE_MAX = 6000;

/**
 * The context of the workspace a version's library is in (its instructions and what each of its context files is,
 * lib/workshop/context.ts) in WORKSPACE_MAX, or "" when the library's owner has no workspace. A library from before workspaces is the first brand's.
 */
export async function workspaceOf(db: DatabaseSync, versionId: string): Promise<string> {
  const id = await workspaceIdOf(db, versionId);
  return id ? workspaceContext(id, WORKSPACE_MAX) : "";
}

/** The id of the workspace a version's library is in (as workspaceOf reads it), or undefined when its owner has none. */
export async function workspaceIdOf(db: DatabaseSync, versionId: string): Promise<string | undefined> {
  const row = db
    .prepare(
      "SELECT l.workspace_id AS home, json_extract(l.settings, '$.projectId') AS ws FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id WHERE v.id = ?",
    )
    .get(versionId) as { home: string; ws: string | null } | undefined;
  if (!row) return undefined;
  const owner = [...listUsers().map((u) => u.username), LOCAL_USER.username].find((u) => homeOf(u) === row.home) ?? row.home;
  const of = await projectOf({ username: owner } as SessionUser);
  return of ? of(row.ws ?? undefined) : undefined;
}

/** Frame times spread over the clip (the middle of each quarter); one frame for a still or a very short clip. */
export const frameTimes = (duration: number) => (duration > 1 ? Array.from({ length: FRAMES }, (_, i) => (duration * (i + 0.5)) / FRAMES) : [0]);

/** The job's AI caller: the platform admin (or the solo install's own account) as admin, anyone else as themselves. */
export const whoFor = (actor: string) => ({ username: actor, role: isAdminActor(actor) ? ("admin" as const) : (findUser(actor)?.role ?? "user") });

/** Stores the AI's description, kind and tags for a version (with the context `stamp` it was written under) and rewrites the asset's search row, in one transaction. */
export function saveDescribed(db: DatabaseSync, versionId: string, d: Described, provider: string, stamp?: string): void {
  const { asset_id } = db.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(versionId) as { asset_id: string };
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO descriptions (version_id, source, text, provider, created_at, roll, kind, stamp) VALUES (?, 'ai', ?, ?, ?, ?, ?, ?)").run(
      versionId,
      d.description,
      provider,
      Date.now(),
      d.roll ?? null,
      d.kind ?? null,
      stamp ?? null,
    );
    db.prepare("DELETE FROM asset_tags WHERE asset_id = ? AND source = 'ai'").run(asset_id);
    const add = db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')");
    for (const t of d.tags) add.run(asset_id, t);
    indexAsset(db, asset_id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Library descriptions running on a connected AI right now. ponytail: one count for every computer; per computer if one person pairs several */
let onProvider = 0;

/**
 * A turn for one description as `actor`: their own Anthropic key takes many at once; a connected AI takes two (its
 * background slots, mac-claude.ts), so a job's time is its own and the estimate can read it. Null when the AI is full
 * (the job waits in the queue); else the function that gives the turn back.
 */
export function describeSlot(actor: string | null): (() => void) | null {
  const free = () => {};
  if (!actor || onApiKey(actor, "analyzer", DESCRIBE_LABEL) || !aiFor(whoFor(actor), "analyzer", DESCRIBE_LABEL).only?.includes("mac")) return free;
  if (onProvider >= BACKGROUND_SLOTS) return null;
  onProvider++;
  let back = false;
  return () => {
    if (!back) onProvider--;
    back = true;
  };
}

/**
 * Describes one version as its job's actor: the route first (no frame is cut without one), then the frames and the AI.
 * Their own Anthropic key goes first (preferKey: bulk work runs many at once on it).
 */
/** `made`: stills already made (a file indexed on a Mac, on-mac.ts): used as they are, and left for the caller to delete. */
export async function describeVersion(db: DatabaseSync, versionId: string, src: string, duration: number, actor: string | null, scratch: string, made?: string[]): Promise<void> {
  // a job with no actor runs as nobody: never on the server's own providers
  if (!actor) throw new NeedsKey("No one to run this as: queue it again from the library");
  const who = whoFor(actor);
  const route = aiFor(who, "analyzer", DESCRIBE_LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const { title } = db.prepare("SELECT a.title FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(versionId) as { title: string };
  const segments = segmentsOf(db, versionId);
  // the frames are cut turned as the clip is now (stills a Mac made are not), so the AI's turn adds to that
  const probe = db.prepare("SELECT probe FROM asset_versions WHERE id = ?").get(versionId) as { probe: string | null } | undefined;
  const base = made ? 0 : asTurn((JSON.parse(probe?.probe ?? "{}") as { turn?: number }).turn);
  const files: string[] = [];
  try {
    if (made) files.push(...made);
    else for (const t of frameTimes(duration)) {
      const file = path.join(scratch, `describe-${randomUUID()}.jpg`);
      files.push(file);
      await ffmpegTo(file, ["-ss", String(t), "-i", src, "-frames:v", "1", "-vf", turned(base, "scale=512:-2"), "-q:v", "4"]);
    }
    const images = await Promise.all(files.map(async (f) => ({ jpegBase64: (await readFile(f)).toString("base64") })));
    // a library the AI organizes: the clip, in no folder yet, goes in the one its answer names (only one of these)
    const filing = toFile(db, versionId);
    const folders = filing ? plainFolders(db, filing.library_id) : undefined;
    const newFolder = !!folders && folders.length < MAX_AI_FOLDERS;
    const wsId = await workspaceIdOf(db, versionId);
    const workspace = wsId ? await workspaceContext(wsId, WORKSPACE_MAX) : "";
    const { system, user } = describePrompt({
      title,
      ...(workspace ? { workspace } : {}),
      frames: images.length,
      ...(segments.length ? { transcript: transcriptExcerpt(segments) } : {}),
      ...(folders ? { folders, newFolder } : {}),
      tags: tagsOf(db, versionId),
    });
    const { value, provider } = await completeVisionWithFallback(system, user, images, undefined, parseDescribe, who, { label: DESCRIBE_LABEL, background: true, preferKey: true });
    // the stamp of the text this call sent: the workspace may have changed while the AI answered
    saveDescribed(db, versionId, value, provider, stampOf(workspace, DESCRIBE_VERSION));
    if (value.turn) await turnVersion(db, versionId, base + value.turn);
    // a new name only while the library may get one; fileInto makes the folder with its first file
    const known = folders?.find((f) => f.toLowerCase() === value.folder?.toLowerCase());
    if (filing && value.folder && (known || newFolder)) fileInto(db, filing, known ?? value.folder);
  } finally {
    if (!made) await Promise.all(files.map((f) => rm(f, { force: true })));
  }
}
