import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SOUNDS, type GeminiModel, type Sound } from "../../contracts/library";
import { env } from "../lib/env";
import { recordUsage } from "../lib/mac-claude";
import { recordService } from "../lib/service-usage";
import { librarySetting, libraryDb } from "./db";
import { workspaceIdOf } from "./describe";
import { looksLikeSong, type ProbeSummary } from "./media/probe";
import { soundMiddle } from "./media/wave";
import { SHORT_SOUND_S } from "./organize";
import { indexAsset } from "./query";
import { nameWords } from "./sfx-type";
import { LISTEN_LABEL } from "./shots";
import { GEMINI_PRICE, parked, watchKey } from "./timeline";

/**
 * Every sound file in a library is known as music or a sound effect (its tag, SOUNDS): the AI Editor takes songs and
 * sound effects only by those tags or folders. Settled once, when the file is probed, in this order:
 *   a. a tag the person gave it (never overruled), or one the app gave it before (a rescan does not flip it);
 *   b. a song by its own tags or its name (probe.ts looksLikeSong);
 *   c. the words of the folders it came from, the nearest first (FOLDER_WORDS);
 *   d. its length: a few seconds is a sound effect (anything longer can be a voice recording: owner, 11-17);
 *   e. what is still unclear: Gemini listens to 30 seconds of it, when the library's AI describes new files, its owner
 *      has a Gemini key. With no listen, the length decides (SHORT_SOUND_S).
 * The app's tag is an "ai" tag: the person can take it off, and then it is never given again (tag_rejections). Gemini
 * hearing someone talk gives neither tag; that is kept as a rejection of both, so the backfill leaves the file alone.
 */

/** Words in a folder's name that say what the sounds in it are. Matched as whole words (sfx-type.ts nameWords). */
export const FOLDER_WORDS: Record<Sound, readonly string[]> = {
  effect: ["sfx", "soundfx", "fx", "foley", "effect", "effects", "soundeffects"],
  music: ["music", "songs", "song", "tracks", "soundtrack", "soundtracks", "beats", "bgm"],
};
/** At most this long: a sound effect by length alone. */
export const CLEARLY_SHORT_S = 6;
/** The most of a file Gemini hears. */
const LISTEN_S = 30;
const LISTEN_MODEL: GeminiModel = "gemini-3.5-flash-lite";

const TAG_KIND: Record<string, Sound> = Object.fromEntries(Object.entries(SOUNDS).map(([k, s]) => [s.tag, k as Sound]));
const TAGS = Object.values(SOUNDS).map((s) => s.tag);

/** The kind the folders of `paths` name: of each path, its nearest folder with a word in FOLDER_WORDS. */
export function kindByFolders(paths: readonly (string | null | undefined)[]): Sound | null {
  for (const p of paths) {
    for (const folder of (p ?? "").split(/[\\/]/).slice(0, -1).reverse()) {
      const words = nameWords(folder);
      for (const k of ["effect", "music"] as const) if (words.some((w) => FOLDER_WORDS[k].includes(w))) return k;
    }
  }
  return null;
}

/** What rules b–d say (a is the caller's: a tag wins before any of this), or null when only listening can tell. */
export function soundKindOf(e: { song?: boolean; paths: readonly (string | null | undefined)[]; seconds: number }): Sound | null {
  if (e.song) return "music";
  const byFolder = kindByFolders(e.paths);
  if (byFolder) return byFolder;
  return e.seconds <= CLEARLY_SHORT_S ? "effect" : null;
}

/** The kind by length alone: what a file with no listen gets. */
export const byLength = (seconds: number): Sound => (seconds < SHORT_SOUND_S ? "effect" : "music");

/** What a listen answers: a kind, someone talking, or nothing (no AI to ask, or it failed). */
export type Heard = Sound | "speech" | null;

interface Row {
  asset: string;
  kind: string;
  paths: (string | null)[];
}

const rowOf = (d: DatabaseSync, versionId: string): Row | undefined => {
  const r = d
    .prepare("SELECT a.id, a.kind, v.source_path, v.from_path, v.mac_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { id: string; kind: string; source_path: string | null; from_path: string | null; mac_path: string | null } | undefined;
  return r && { asset: r.id, kind: r.kind, paths: [r.source_path, r.from_path, r.mac_path] };
};

/** The sound tag the asset has (the person's first), or null; and the sound tags taken off it. */
function tagsOf(d: DatabaseSync, assetId: string): { has: Sound | null; off: Set<string> } {
  const has = d.prepare(`SELECT tag FROM asset_tags WHERE asset_id = ? AND tag IN (${TAGS.map(() => "?").join(", ")}) ORDER BY source = 'user' DESC LIMIT 1`).get(assetId, ...TAGS) as
    | { tag: string }
    | undefined;
  const off = d.prepare(`SELECT tag FROM tag_rejections WHERE asset_id = ? AND tag IN (${TAGS.map(() => "?").join(", ")})`).all(assetId, ...TAGS) as { tag: string }[];
  return { has: has ? TAG_KIND[has.tag] : null, off: new Set(off.map((o) => o.tag)) };
}

/**
 * Settles a probed version's kind (the rules above) and tags it: music or a sound effect, or null (not a sound, someone
 * talking, or the kind's tag was taken off). A video is only ever music, as a song (b). `listen` is asked only for what
 * rules a–d leave unclear.
 */
export async function settleSoundKind(d: DatabaseSync, versionId: string, e: { song: boolean; seconds: number; listen?: () => Promise<Heard> }): Promise<Sound | null> {
  const r = rowOf(d, versionId);
  if (!r) return null;
  const { has, off } = tagsOf(d, r.asset);
  if (has) return has;
  if (off.size === TAGS.length) return null; // both taken off, or heard as someone talking before
  let kind: Sound | null = r.kind === "audio" ? soundKindOf({ song: e.song, paths: r.paths, seconds: e.seconds }) : e.song ? "music" : null;
  if (r.kind === "audio" && !kind) {
    const heard = e.listen
      ? await e.listen().catch((err: unknown) => {
          console.warn("[library] listen:", err);
          return null;
        })
      : null;
    if (heard === "speech") {
      for (const t of TAGS) d.prepare("INSERT OR IGNORE INTO tag_rejections (asset_id, tag) VALUES (?, ?)").run(r.asset, t);
      return null;
    }
    kind = heard ?? byLength(e.seconds);
  }
  if (!kind || off.has(SOUNDS[kind].tag)) return null;
  d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(r.asset, SOUNDS[kind].tag);
  indexAsset(d, r.asset);
  return kind;
}

/**
 * Gemini hears up to LISTEN_S seconds from the middle of `file` and says music, sound effect or someone talking. Null
 * when the library's AI is off (describe), `actor` has no Gemini key or its credit is out.
 * ponytail: one call, no retry; a busy or failed Gemini leaves the file to its length
 */
export async function listen(d: DatabaseSync, versionId: string, libraryId: string, file: string, seconds: number, actor: string | null): Promise<Heard> {
  const key = watchKey(actor);
  if (!key || !librarySetting(libraryId, "describe") || (parked.get(key)?.until ?? 0) > Date.now()) return null;
  const clip = path.join(process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch"), `listen-${randomUUID()}.mp3`);
  try {
    await soundMiddle(file, seconds, LISTEN_S, clip);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${LISTEN_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "audio/mpeg", data: (await readFile(clip)).toString("base64") } },
              {
                text: "A sound file from a video editor's media library. Is it music (a song, a beat, a backing track, a jingle), a sound effect (one sound, foley, an ambience, a whoosh, a riser, noise), or someone talking?",
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: { kind: { type: "string", enum: ["music", "effect", "speech"] } }, required: ["kind"] } },
      }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
    const u = body.usageMetadata ?? {};
    const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    const price = GEMINI_PRICE[LISTEN_MODEL];
    void recordUsage(LISTEN_LABEL, { tokens: (u.promptTokenCount ?? 0) + out, costUsd: ((u.promptTokenCount ?? 0) * price.in + out * price.out) / 1e6, input: u.promptTokenCount ?? 0, output: out, model: LISTEN_MODEL }, undefined, "workspace", (await workspaceIdOf(d, versionId)) ?? null);
    void recordService({ service: "GEMINI_API_KEY", key, actor, label: "Media Library: sound kinds", units: (u.promptTokenCount ?? 0) + out, unit: "tokens", costUsd: ((u.promptTokenCount ?? 0) * price.in + out * price.out) / 1e6 });
    const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    const kind = (JSON.parse(text || "{}") as { kind?: string }).kind;
    return kind === "music" || kind === "effect" || kind === "speech" ? kind : null;
  } finally {
    await rm(clip, { force: true });
  }
}

/**
 * Sound files from before every sound got its kind: the ones with no sound tag are settled by rules b–d and their
 * length, no AI. Once per start of the server, 500 a turn while the library's files lane is idle (worker.ts).
 */
let backfillAfter = 0;
let backfilled = false;
export async function backfillSoundKinds(d = libraryDb()): Promise<boolean> {
  if (backfilled) return false;
  const rows = d
    .prepare(
      `SELECT v.rowid, v.id, a.title, v.probe FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.kind = 'audio' AND a.trashed_at IS NULL AND v.probe IS NOT NULL AND v.rowid > ?
         AND NOT EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag IN (${TAGS.map(() => "?").join(", ")}))
       ORDER BY v.rowid LIMIT 500`,
    )
    .all(backfillAfter, ...TAGS) as { rowid: number; id: string; title: string; probe: string }[];
  backfilled = !rows.length;
  backfillAfter = rows.at(-1)?.rowid ?? 0;
  for (const r of rows) {
    const p = JSON.parse(r.probe) as ProbeSummary;
    await settleSoundKind(d, r.id, { song: looksLikeSong(r.title, p), seconds: p.duration ?? 0 }); // no listen
  }
  return rows.length > 0;
}
