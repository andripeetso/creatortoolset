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
import { workspaceContext } from "../lib/workshop/context";
import { homeOf } from "./access";
import { transcriptExcerpt } from "./attach";
import { ffmpegTo } from "./media/run";
import { indexAsset } from "./query";
import { NeedsKey, segmentsOf } from "./transcribe";
import { isAdminActor } from "../my-keys";
import type { Roll } from "./roll";
import { fileInto, MAX_AI_FOLDERS, plainFolders, toFile } from "./organize";

/**
 * The library's `describe` job (tasks/media-library-plan.md, sections 5 and 11): four frames, the title and a
 * transcript excerpt go to the actor's own AI (aiFor: their provider, or their own Anthropic key).
 * No route parks the job as needs_key, never failed and never on someone else's AI. The answer is JSON: a description
 * and tags, stored as the AI's, and in the same answer whether the clip is A-roll or B-roll (roll.ts reads it). A human's description stays the one shown (query.ts); human tags keep their source.
 * On unless the library's owner switched it off (settings.describe; db.ts SETTING_DEFAULTS): a big upload says first what it spends.
 */

export const FRAMES = 4;
/** What the usage tally counts a description as: estimate.ts reads its average cost back. */
export const DESCRIBE_LABEL = "Media Library describe";
const MAX_TAGS = 8;

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
}

export interface Described {
  description: string;
  tags: string[];
  /** "a": someone talks to the camera through most of it; "b": anything else. Absent when the answer had none */
  roll?: Roll;
  /** the folder it fits, of the ones it was given (or none) */
  folder?: string;
}

export function describePrompt(input: DescribeInput): { system: string; user: string } {
  return {
    system:
      "You describe one clip in a creator's media library so they can find it later by searching. Say what is seen and heard: " +
      "the setting, what happens, objects, shot type and mood. Never say who anyone is: no names, no guessed ages, no " +
      'identities; "a person" or "people" is enough. Answer with JSON only.',
    user: [
      ...(input.workspace
        ? [`The workspace this clip belongs to. Use it to name what is seen (the product, the game, its places and features) when the frames show it; never add what they don't show:\n${input.workspace}`]
        : []),
      `Title: ${input.title}`,
      input.transcript ? `What is said (excerpt):\n${input.transcript}` : "Nothing is transcribed.",
      input.frames > 1 ? `The ${input.frames} pictures are frames from the start to the end of the clip, in order.` : "The picture is the whole clip: a photo, or a clip too short for more.",
      'roll is "a" when a person talks to the camera (or to someone just beside it) through most of the clip, a take a video could be built on; else "b" (scenery, action, details, people not talking to the camera).',
      ...(input.folders
        ? [
            input.newFolder
              ? `folder is where this clip is filed in the library, judged by what the footage is (gameplay, an interview, a product, a place…). ${input.folders.length ? `Use one of these folders when it fits: ${JSON.stringify(input.folders)}. Otherwise name` : "Name"} a new folder: one to three words, by what the footage is (for example "Gameplay", "Interviews", "Product shots", "Travel"), never a vague name like "Misc", "Other", "Clips" or "B-roll".`
              : `folder is the one of these folders the clip fits best: ${JSON.stringify(input.folders)}`,
            'Answer as {"description": "two or three plain sentences", "tags": ["up to 8 short lowercase search words"], "roll": "a" or "b", "folder": "a folder name"}',
          ]
        : ['Answer as {"description": "two or three plain sentences", "tags": ["up to 8 short lowercase search words"], "roll": "a" or "b"}']),
    ].join("\n\n"),
  };
}

/** The answer's description and tags; any other key the model adds is dropped. */
export function parseDescribe(text: string): Described {
  const o = parseJsonObject(text);
  const description = typeof o.description === "string" ? o.description.trim().slice(0, 1000) : "";
  if (!description) throw new Error("The AI returned no description");
  const tags = Array.isArray(o.tags)
    ? [...new Set(o.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS)
    : [];
  const folder = typeof o.folder === "string" ? o.folder.trim() : "";
  return { description, tags, ...(o.roll === "a" || o.roll === "b" ? { roll: o.roll } : {}), ...(folder ? { folder } : {}) };
}

/** Most of the workspace's context a description carries: it rides every clip's call. */
export const WORKSPACE_MAX = 6000;

/**
 * The context of the workspace a version's library is in (its instructions and what each of its context files is,
 * lib/workshop/context.ts) in WORKSPACE_MAX, or "" when the library's owner has no workspace. A library from before workspaces is the first brand's.
 */
export async function workspaceOf(db: DatabaseSync, versionId: string): Promise<string> {
  const row = db
    .prepare(
      "SELECT l.workspace_id AS home, json_extract(l.settings, '$.projectId') AS ws FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id WHERE v.id = ?",
    )
    .get(versionId) as { home: string; ws: string | null } | undefined;
  if (!row) return "";
  const owner = [...listUsers().map((u) => u.username), LOCAL_USER.username].find((u) => homeOf(u) === row.home) ?? row.home;
  const of = await projectOf({ username: owner } as SessionUser);
  if (!of) return "";
  return workspaceContext(of(row.ws ?? undefined), WORKSPACE_MAX);
}

/** Frame times spread over the clip (the middle of each quarter); one frame for a still or a very short clip. */
export const frameTimes = (duration: number) => (duration > 1 ? Array.from({ length: FRAMES }, (_, i) => (duration * (i + 0.5)) / FRAMES) : [0]);

/** The job's AI caller: the platform admin (or the solo install's own account) as admin, anyone else as themselves. */
export const whoFor = (actor: string) => ({ username: actor, role: isAdminActor(actor) ? ("admin" as const) : (findUser(actor)?.role ?? "user") });

/** Stores the AI's description and tags for a version and rewrites the asset's search row, in one transaction. */
export function saveDescribed(db: DatabaseSync, versionId: string, d: Described, provider: string): void {
  const { asset_id } = db.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(versionId) as { asset_id: string };
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', ?, ?, ?, ?)").run(
      versionId,
      d.description,
      provider,
      Date.now(),
      d.roll ?? null,
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
  const files: string[] = [];
  try {
    if (made) files.push(...made);
    else for (const t of frameTimes(duration)) {
      const file = path.join(scratch, `describe-${randomUUID()}.jpg`);
      files.push(file);
      await ffmpegTo(file, ["-ss", String(t), "-i", src, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4"]);
    }
    const images = await Promise.all(files.map(async (f) => ({ jpegBase64: (await readFile(f)).toString("base64") })));
    // a library the AI organizes: the clip, in no folder yet, goes in the one its answer names (only one of these)
    const filing = toFile(db, versionId);
    const folders = filing ? plainFolders(db, filing.library_id) : undefined;
    const newFolder = !!folders && folders.length < MAX_AI_FOLDERS;
    const workspace = await workspaceOf(db, versionId);
    const { system, user } = describePrompt({
      title,
      ...(workspace ? { workspace } : {}),
      frames: images.length,
      ...(segments.length ? { transcript: transcriptExcerpt(segments) } : {}),
      ...(folders ? { folders, newFolder } : {}),
    });
    const { value, provider } = await completeVisionWithFallback(system, user, images, undefined, parseDescribe, who, { label: DESCRIBE_LABEL, background: true, preferKey: true });
    saveDescribed(db, versionId, value, provider);
    // a new name only while the library may get one; fileInto makes the folder with its first file
    const known = folders?.find((f) => f.toLowerCase() === value.folder?.toLowerCase());
    if (filing && value.folder && (known || newFolder)) fileInto(db, filing, known ?? value.folder);
  } finally {
    if (!made) await Promise.all(files.map((f) => rm(f, { force: true })));
  }
}
