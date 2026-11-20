import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { aiFor, completeWithFallback } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { emitEvent } from "../lib/events";
import { ask, noul, yes } from "../lib/jev";
import { parseJsonObject } from "../lib/instagram/vision";
import { keyFor } from "../my-keys";
import type { SessionUser } from "../users";
import { blobs, libraryDb } from "./db";
import { mayLeave } from "./upload-gate";
import { FINISHED } from "./query";

/**
 * Smart folders. A plain folder with a rule (collections.rule: the person's own words on what goes in it, "phone
 * gameplay: touch buttons in the corners") is filled by the AI. The clips it files are real items (by_ai = 1), so the
 * folder's count, pictures, the top level and drag work as for any folder. A clip the person takes out is never filed
 * there again (folder_out); one they put in stays whatever the rule says.
 *
 * The judge reads what each clip already has (title, description, tags, kind, length, picture size): TypeSafe Jev
 * (lib/jev.ts) with one yes/no per smart folder per clip, about 0.0001 cents each; without a Jev key the library's AI
 * reads 40 clips at a time. Only a clip Jev is unsure of (between UNSURE and YES) is looked at: its card picture and
 * frame strip go to the person's AI with just those folders. A clip still unsure stays where it was. A new clip is judged once it is described (describe.ts); saving a rule
 * judges the whole library against that folder (sortFolder). Reorganize (suggestWays) has the AI propose whole ways of
 * sorting the library, each folder with its rule and how many clips would go in it.
 */

export const LABEL = "Media Library smart folders";
/** Jev's yes at or over this files the clip. ponytail: one cut for every folder; per folder if some come out too loose */
const YES = 0.6;
/** Jev's yes from here up to YES: the pictures decide (look) */
const UNSURE = 0.3;
const LOOK_AT_ONCE = 2;
const RULE_MAX = 600;
const AI_BATCH = 40;
const JEV_AT_ONCE = 6;
/** Clips a Reorganize idea is counted on; a bigger library's counts are scaled from these */
const COUNT_SAMPLE = 150;
const WORKSPACE_MAX = 3000;

type Who = Pick<SessionUser, "username" | "role">;
export interface Rule {
  id: string;
  name: string;
  rule: string;
}
interface Clip {
  id: string;
  version: string;
  title: string;
  kind: string;
  what: string | null;
  description: string | null;
  tags: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
  turn: number | null;
}

/** A rule as kept: trimmed, at most RULE_MAX characters, null when empty. */
export const ruleOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, RULE_MAX) : null);

/** Whether `who` has something to judge with: a Jev key, or an AI. */
export const canJudge = (who: Who): boolean => !!keyFor(who, "TYPESAFE_API_KEY").key || !aiFor(who, "analyzer", LABEL).off;

const CLIP = `SELECT a.id, v.id AS version, a.title, a.kind,
    (SELECT d.kind FROM descriptions d WHERE d.version_id = v.id AND d.source = 'ai') AS what,
    (SELECT d.text FROM descriptions d WHERE d.version_id = v.id ORDER BY d.source = 'user' DESC LIMIT 1) AS description,
    (SELECT group_concat(t.tag, ', ') FROM asset_tags t WHERE t.asset_id = a.id) AS tags,
    json_extract(v.probe, '$.duration') AS duration, json_extract(v.probe, '$.width') AS width, json_extract(v.probe, '$.height') AS height,
    json_extract(v.probe, '$.rotation') AS rotation, json_extract(v.probe, '$.turn') AS turn
  FROM assets a JOIN asset_versions v ON v.id = a.current_version_id`;

/** The library's clips a smart folder may hold: live, ready, not finished work. */
const clipsOf = (d: DatabaseSync, libraryId: string) =>
  d.prepare(`${CLIP} WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND v.state = 'ready' AND NOT ${FINISHED} ORDER BY a.created_at DESC, a.id`).all(libraryId) as unknown as Clip[];

/** The library's smart folders. */
export const rulesOf = (d: DatabaseSync, libraryId: string): Rule[] =>
  d.prepare("SELECT id, name, rule FROM collections WHERE library_id = ? AND rule IS NOT NULL ORDER BY created_at, id").all(libraryId) as unknown as Rule[];

/** The picture as it is watched (the file's rotation, then the AI's turn), its shape in words the judge can match. */
function pictureOf(c: Clip): string | null {
  if (!c.width || !c.height) return null;
  const quarter = (((c.rotation ?? 0) + (c.turn ?? 0)) / 90) % 2 === 1;
  const [w, h] = quarter ? [c.height, c.width] : [c.width, c.height];
  const r = w / h;
  return `${w}×${h} (${r >= 1 ? `${r.toFixed(2)}:1, landscape` : `1:${(1 / r).toFixed(2)}, portrait`}; 16:9 is 1.78:1, a phone screen is about 2.1:1 to 2.2:1)`;
}

/** One clip as the judge reads it. */
export function clipText(c: Clip): string {
  const picture = pictureOf(c);
  return [
    `Title: ${c.title}`,
    `File: ${c.kind}${c.duration ? `, ${Math.round(c.duration)} s` : ""}`,
    picture && `Picture: ${picture}`,
    c.what && `What it is: ${c.what}`,
    c.description && `Description: ${c.description.slice(0, 800)}`,
    c.tags && `Tags: ${c.tags}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Up to five clips the person put in each folder, and five they took out: what the rule means, by example. */
function examplesOf(d: DatabaseSync, rules: Rule[]): Record<string, { in: string[]; out: string[] }> {
  const put = d.prepare(`${CLIP} JOIN collection_items i ON i.asset_id = a.id WHERE i.collection_id = ? AND i.by_ai = 0 AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL ORDER BY i.position DESC LIMIT 5`);
  const out = d.prepare(`${CLIP} JOIN folder_out o ON o.asset_id = a.id WHERE o.collection_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL LIMIT 5`);
  const brief = (c: Clip) => clipText(c).slice(0, 300);
  return Object.fromEntries(
    rules.map((r) => [r.id, { in: (put.all(r.id) as unknown as Clip[]).map(brief), out: (out.all(r.id) as unknown as Clip[]).map(brief) }]),
  );
}

const question = (r: Rule, ex?: { in: string[]; out: string[] }) =>
  [
    `The folder "${r.name}" holds: ${r.rule}`,
    ex?.in.length ? `Clips the person put in it themselves:\n${ex.in.join("\n---\n")}` : "",
    ex?.out.length ? `Clips the person took out of it:\n${ex.out.join("\n---\n")}` : "",
    `Does this clip belong in "${r.name}"?`,
  ]
    .filter(Boolean)
    .join("\n\n");

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/** The folders a clip goes in, and the ones it was not judged on clearly (left as they are). */
export interface Verdict {
  in: string[];
  unsure: string[];
}

/** The clip's pictures the library keeps (its card picture, its frame strip), for the AI to look at. */
async function picturesOf(d: DatabaseSync, versionId: string): Promise<{ jpegBase64: string }[]> {
  // Blur faces: a picture of a clip not blurred, kept from before it was on, goes into no AI call
  const lib = (d.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string } | undefined)?.library_id;
  if (!mayLeave(lib, { versionId }).ok) return [];
  const rows = d.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind IN ('thumb', 'sprite') AND storage_key IS NOT NULL ORDER BY kind DESC").all(versionId) as {
    storage_key: string;
  }[];
  const out: { jpegBase64: string }[] = [];
  for (const r of rows) {
    const file = await blobs.localCopy(r.storage_key).catch(() => null);
    if (file) out.push({ jpegBase64: (await readFile(file)).toString("base64") });
  }
  return out;
}

/** A clip Jev was unsure of, looked at: which of `rules` its pictures show it belongs in. Null: nothing to look at, or no answer. */
async function look(d: DatabaseSync, who: Who, ws: string, c: Clip, rules: Rule[], examples: Record<string, { in: string[]; out: string[] }>): Promise<string[] | null> {
  const images = await picturesOf(d, c.version);
  if (!images.length) return null;
  const user = [
    ws && `The workspace this clip belongs to:\n${ws}`,
    `The folders:\n\n${rules.map((r, i) => `${i + 1}. ${question(r, examples[r.id]).replace(/\n\nDoes this clip belong in "[^"]*"\?$/, "")}`).join("\n\n")}`,
    `The clip:\n${clipText(c)}`,
    `The pictures are the clip's card picture${images.length > 1 ? " and a strip of frames from its start to its end, cropped to 16:9 (the Picture line above has its real shape)" : ""}.`,
    'Answer as {"in": [folder numbers]}: the folders it belongs in, [] for none.',
  ]
    .filter(Boolean)
    .join("\n\n");
  const picked = await completeVisionWithFallback(
    "You sort one clip of a creator's media library into folders by what each folder says it holds, looking at its pictures. Put it in a folder only when the pictures and what is known about it clearly fit. Answer with JSON only.",
    user,
    images,
    undefined,
    (text) => {
      const o = parseJsonObject(text);
      if (!Array.isArray(o.in)) throw new Error("The answer has no list of folders");
      return o.in as unknown[];
    },
    who,
    { label: LABEL, background: true, preferKey: true },
  ).then((r) => r.value, () => null);
  return picked ? rules.filter((_, i) => picked.includes(i + 1)).map((r) => r.id) : null;
}

/**
 * For each clip, the folders it belongs in. A clip whose judging fails is left out of the answer (filed as it was).
 * Jev when `who` has a key (with `pictures`, what it was unsure of is looked at), else their AI; with neither, nothing.
 */
export async function judge(
  who: Who,
  workspace: string,
  clips: Clip[],
  rules: Rule[],
  examples: Record<string, { in: string[]; out: string[] }> = {},
  pictures = true,
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  if (!clips.length || !rules.length) return out;
  const key = keyFor(who, "TYPESAFE_API_KEY").key;
  const ws = workspace.slice(0, WORKSPACE_MAX);
  if (key) {
    const questions = Object.fromEntries(rules.map((r, i) => [`f${i}`, noul(question(r, examples[r.id]))]));
    await pool(clips, JEV_AT_ONCE, async (c) => {
      const a = await ask(key, { ...(ws ? { workspace: ws } : {}), clip: clipText(c) }, questions).catch(() => null);
      if (!a) return;
      const p = (i: number) => yes(a[`f${i}`]);
      out.set(c.id, { in: rules.filter((_, i) => p(i) >= YES).map((r) => r.id), unsure: rules.filter((_, i) => p(i) >= UNSURE && p(i) < YES).map((r) => r.id) });
    });
    if (!pictures) return out;
    const d = libraryDb();
    const doubts = clips.filter((c) => out.get(c.id)?.unsure.length);
    await pool(doubts, LOOK_AT_ONCE, async (c) => {
      const v = out.get(c.id)!;
      const asked = rules.filter((r) => v.unsure.includes(r.id));
      const seen = await look(d, who, ws, c, asked, examples);
      if (seen) out.set(c.id, { in: [...v.in, ...seen], unsure: [] });
    });
    return out;
  }
  const route = aiFor(who, "analyzer", LABEL);
  if (route.off) return out;
  const folders = rules.map((r, i) => `${i + 1}. ${question(r, examples[r.id]).replace(/\n\nDoes this clip belong in "[^"]*"\?$/, "")}`).join("\n\n");
  for (let i = 0; i < clips.length; i += AI_BATCH) {
    const batch = clips.slice(i, i + AI_BATCH);
    const user = [
      ws && `The workspace these clips belong to:\n${ws}`,
      `The folders:\n\n${folders}`,
      `The clips:\n\n${batch.map((c, k) => `Clip ${k + 1}\n${clipText(c)}`).join("\n\n")}`,
      `Answer as {"1": [folder numbers], "2": [], …} with every clip's number: the folders each clip belongs in, [] for none.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const parsed = await completeWithFallback(
      "You sort the clips of a creator's media library into folders by what each folder says it holds. A clip may fit several folders or none: put it in a folder only when what is known about it clearly fits. Answer with JSON only.",
      user,
      undefined,
      (text) => parseJsonObject(text),
      route,
    ).catch(() => null);
    if (!parsed) continue;
    batch.forEach((c, k) => {
      const picks = parsed[String(k + 1)];
      if (Array.isArray(picks)) out.set(c.id, { in: rules.filter((_, n) => picks.includes(n + 1)).map((r) => r.id), unsure: [] });
    });
  }
  return out;
}

/** Files and unfiles by the judge's answer, within `rules`: never a clip the person took out, never one they put in, and a folder it is still unsure of stays as it was. Returns how many it filed. */
function apply(d: DatabaseSync, answers: Map<string, Verdict>, rules: Rule[]): number {
  const kept = d.prepare("SELECT 1 FROM folder_out WHERE collection_id = ? AND asset_id = ?");
  const add = d.prepare(
    `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by, by_ai)
     SELECT ?, ?, COALESCE(MAX(position), 0) + 1, 'ai', 1 FROM collection_items WHERE collection_id = ?`,
  );
  const drop = d.prepare("DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ? AND by_ai = 1");
  let filed = 0;
  for (const [asset, v] of answers) {
    for (const r of rules) {
      if (v.in.includes(r.id)) {
        if (!kept.get(r.id, asset)) filed += add.run(r.id, asset, r.id).changes as number;
      } else if (!v.unsure.includes(r.id)) drop.run(r.id, asset);
    }
  }
  return filed;
}

/** A clip just described, or its words or picture changed by hand: judged against every smart folder of its library. Returns how many folders it went in; null when the library has no smart folder. */
export async function fileSmart(d: DatabaseSync, versionId: string, who: Who, workspace: string): Promise<number | null> {
  const c = d.prepare(`${CLIP} WHERE v.id = ? AND a.current_version_id = v.id AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND NOT ${FINISHED}`).get(versionId) as unknown as Clip | undefined;
  const lib = c && (d.prepare("SELECT library_id FROM assets WHERE id = ?").get(c.id) as { library_id: string }).library_id;
  const rules = lib ? rulesOf(d, lib) : [];
  if (!rules.length) return null;
  if (!c) return 0;
  return apply(d, await judge(who, workspace, [c], rules, examplesOf(d, rules)), rules);
}

// ponytail: in memory, so a restart mid-sort leaves the folder half sorted until its rule is saved again
const sorting = new Map<string, symbol>();
/** Whether the folder is being sorted now. */
export const isSorting = (folderId: string) => sorting.has(folderId);

/**
 * The folder's rule was saved: every clip of the library is judged against it, in the background. The clips it filed
 * before and no longer fits leave it; with no rule (smart sorting switched off), all the clips it filed leave.
 */
export function sortFolder(libraryId: string, folderId: string, who: Who, context: string | Promise<string>): Promise<number> {
  const me = Symbol(folderId);
  sorting.set(folderId, me);
  return (async () => {
    const workspace = await context;
    const d = libraryDb();
    const rules = rulesOf(d, libraryId).filter((r) => r.id === folderId);
    if (!rules.length) {
      d.prepare("DELETE FROM collection_items WHERE collection_id = ? AND by_ai = 1").run(folderId);
      return 0;
    }
    const clips = clipsOf(d, libraryId);
    const examples = examplesOf(d, rules);
    let filed = 0;
    // in steps, so the page fills as it goes
    for (let i = 0; i < clips.length; i += 30) {
      const answers = await judge(who, workspace, clips.slice(i, i + 30), rules, examples);
      // the rule may have changed while this step ran: the newer save sorts again
      if (sorting.get(folderId) !== me) return filed;
      filed += apply(d, answers, rules);
      emitEvent("library.changed", {});
    }
    return filed;
  })().finally(() => {
    if (sorting.get(folderId) === me) sorting.delete(folderId);
    emitEvent("library.changed", {}); // the card's "Sorting" goes
  });
}

export interface WayFolder {
  name: string;
  rule: string;
  /** clips that would go in it; with `about`, scaled from COUNT_SAMPLE */
  count?: number;
}
export interface Way {
  name: string;
  folders: WayFolder[];
}

/** Two to three ways from the AI's answer, each with two to eight folders that have a name and a rule. */
export function parseWays(text: string): Way[] {
  const o = parseJsonObject(text);
  const ways = (Array.isArray(o.ways) ? o.ways : [])
    .map((w: unknown) => {
      const r = (w ?? {}) as Record<string, unknown>;
      const folders = (Array.isArray(r.folders) ? r.folders : [])
        .map((f: unknown) => {
          const x = (f ?? {}) as Record<string, unknown>;
          const name = typeof x.name === "string" ? x.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
          const rule = ruleOf(x.rule);
          return name && rule && name.toLowerCase() !== "finals" ? { name, rule } : null;
        })
        .filter((f): f is WayFolder => !!f)
        .slice(0, 8);
      const name = typeof r.name === "string" ? r.name.trim().slice(0, 60) : "";
      return name && folders.length >= 2 ? { name, folders } : null;
    })
    .filter((w): w is Way => !!w)
    .slice(0, 3);
  if (!ways.length) throw new Error("Could not suggest folders");
  return ways;
}

/**
 * Reorganize: two or three ways to sort the library into folders, from its tags, its clips' descriptions and the
 * workspace, each folder with a rule in plain words and how many clips would go in it (judged on up to COUNT_SAMPLE of
 * them). `about`: the library has more clips than that, so the counts are scaled.
 */
export async function suggestWays(libraryId: string, who: Who, workspace: string): Promise<{ ways: Way[]; about: boolean }> {
  const d = libraryDb();
  const clips = clipsOf(d, libraryId);
  if (!clips.length) throw new Error("No clips to sort");
  const route = aiFor(who, "analyzer", LABEL);
  if (route.off) throw new Error(route.off);
  const tags = d
    .prepare(
      `SELECT t.tag, COUNT(*) AS n FROM asset_tags t JOIN assets a ON a.id = t.asset_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL
       GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 80`,
    )
    .all(libraryId) as { tag: string; n: number }[];
  const folders = (d.prepare("SELECT name FROM collections WHERE library_id = ? AND parent_id IS NULL ORDER BY created_at").all(libraryId) as { name: string }[]).map((f) => f.name);
  const user = [
    workspace && `The workspace this library belongs to:\n${workspace.slice(0, WORKSPACE_MAX)}`,
    `The library has ${clips.length} clips. Its folders now: ${folders.length ? JSON.stringify(folders) : "none"}.`,
    tags.length ? `Its tags (tag: clips): ${tags.map((t) => `${t.tag}: ${t.n}`).join(", ")}` : "",
    `Some of its clips:\n\n${clips.slice(0, 60).map((c) => clipText(c).slice(0, 400)).join("\n\n")}`,
    `Propose two or three different ways to sort this library into folders, each by one thing that tells its clips apart and that matters for making videos from them (where it was filmed or which part of the game, what device, what happens, who or what it shows…). Each way has two to eight folders that between them hold most clips. A folder's rule says, in the creator's plain words, what goes in it and how to tell (what is seen, said, the picture's shape), so a clip can be judged by it alone. Never "Misc" or "Other", never "Finals", and never a folder only for photos: the library already has a Photos tab.`,
    `Answer as {"ways": [{"name": "By …", "folders": [{"name": "one to three words", "rule": "one or two sentences"}]}]}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const ways = await completeWithFallback(
    "You help a creator organize their media library into folders. Answer with JSON only.",
    user,
    undefined,
    parseWays,
    route,
  );
  const sample = clips.slice(0, COUNT_SAMPLE);
  const all: Rule[] = ways.flatMap((w, i) => w.folders.map((f, k) => ({ id: `${i}.${k}`, name: f.name, rule: f.rule })));
  const answers = await judge(who, workspace, sample, all, {}, false).catch(() => new Map<string, Verdict>());
  if (answers.size) {
    const scale = clips.length / answers.size;
    ways.forEach((w, i) =>
      w.folders.forEach((f, k) => {
        let n = 0;
        for (const v of answers.values()) if (v.in.includes(`${i}.${k}`)) n++;
        f.count = Math.round(n * scale);
      }),
    );
  }
  return { ways, about: answers.size > 0 && answers.size < clips.length };
}
