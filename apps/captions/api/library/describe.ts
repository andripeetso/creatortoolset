import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { aiFor, onApiKey } from "../ai-complete";
import { BACKGROUND_SLOTS } from "../lib/mac-claude";
import { completeVisionWithFallback } from "../ai-vision";
import { parseJsonObject } from "../lib/instagram/vision";
import { findUser } from "../users";
import { transcriptExcerpt } from "./attach";
import { ffmpegTo } from "./media/run";
import { indexAsset } from "./query";
import { NeedsKey, segmentsOf } from "./transcribe";
import { isAdminActor } from "../my-keys";

/**
 * The library's `describe` job (tasks/media-library-plan.md, sections 5 and 11): four frames, the title and a
 * transcript excerpt go to the actor's own AI (aiFor: their provider, or their own Anthropic key).
 * No route parks the job as needs_key, never failed and never on someone else's AI. The answer is JSON: a description
 * and tags, stored as the AI's. A human's description stays the one shown (query.ts); human tags keep their source.
 * Off unless the library's owner switched it on (settings.describe), since it spends AI on every upload.
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
}

export interface Described {
  description: string;
  tags: string[];
}

export function describePrompt(input: DescribeInput): { system: string; user: string } {
  return {
    system:
      "You describe one clip in a creator's media library so they can find it later by searching. Say what is seen and heard: " +
      "the setting, what happens, objects, shot type and mood. Never say who anyone is: no names, no guessed ages, no " +
      'identities; "a person" or "people" is enough. Answer with JSON only.',
    user: [
      `Title: ${input.title}`,
      input.transcript ? `What is said (excerpt):\n${input.transcript}` : "Nothing is transcribed.",
      `The ${input.frames} pictures are frames from the start to the end of the clip, in order.`,
      'Answer as {"description": "two or three plain sentences", "tags": ["up to 8 short lowercase search words"]}',
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
  return { description, tags };
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
    db.prepare("INSERT OR REPLACE INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'ai', ?, ?, ?)").run(
      versionId,
      d.description,
      provider,
      Date.now(),
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
export async function describeVersion(db: DatabaseSync, versionId: string, src: string, duration: number, actor: string | null, scratch: string): Promise<void> {
  // a job with no actor runs as nobody: never on the server's own providers
  if (!actor) throw new NeedsKey("No one to run this as: queue it again from the library");
  const who = whoFor(actor);
  const route = aiFor(who, "analyzer", DESCRIBE_LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const { title } = db.prepare("SELECT a.title FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(versionId) as { title: string };
  const segments = segmentsOf(db, versionId);
  const files: string[] = [];
  try {
    for (const t of frameTimes(duration)) {
      const file = path.join(scratch, `describe-${randomUUID()}.jpg`);
      files.push(file);
      await ffmpegTo(file, ["-ss", String(t), "-i", src, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4"]);
    }
    const images = await Promise.all(files.map(async (f) => ({ jpegBase64: (await readFile(f)).toString("base64") })));
    const { system, user } = describePrompt({ title, frames: images.length, ...(segments.length ? { transcript: transcriptExcerpt(segments) } : {}) });
    const { value, provider } = await completeVisionWithFallback(system, user, images, undefined, parseDescribe, who, { label: DESCRIBE_LABEL, background: true, preferKey: true });
    saveDescribed(db, versionId, value, provider);
  } finally {
    await Promise.all(files.map((f) => rm(f, { force: true })));
  }
}
