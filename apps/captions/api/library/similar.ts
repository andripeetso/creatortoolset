import type { SimilarMatch } from "../../contracts/library";
import type { SocialPlatform } from "../../contracts/connectors";
import { QA } from "../editor/qa";
import { readConnectors } from "../lib/connectors/store";
import { findUser, mayUse } from "../users";
import { homeOf, libraryRole } from "./access";
import { libraryDb } from "./db";
import type { Fingerprint } from "./fingerprint";
import { enqueueJob } from "./jobs";
import type { TimedWord } from "./transcribe";

/**
 * The duplicate check (tasks/media-library-plan.md, section 10): which videos in the caller's libraries share
 * pictures with a clip, by the per-second pHashes of the `fingerprint` derivative. A second of the clip matches when
 * some second of the other video is within MAX_BITS of it; `overlap` is the share of the clip's seconds that match.
 * The Video Cleaner calls similarTo with a file that is not in the library; similar(versionId) is the same for a
 * library version.
 */

const MAX_BITS = 10; // fingerprint.test.ts measured about 3 for a re-encode, about 31 for another video
export const MIN_OVERLAP = 0.3;
export const TOP = 10;

/** A hex pHash as two 32-bit halves, so a comparison is two XORs and two bit counts. */
const halves = (h: string): [number, number] => [parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16)];
const bits = (x: number) => {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
};

/** The share of `query`'s seconds (0..1) that have a second within MAX_BITS somewhere in `theirs`. Shared with posted reels. */
export function overlapOf(query: string[], theirs: string[]): number {
  const t = theirs.map(halves);
  let hit = 0;
  for (const h of query) {
    const [qa, qb] = halves(h);
    if (t.some(([a, b]) => bits((qa ^ a) >>> 0) + bits((qb ^ b) >>> 0) <= MAX_BITS)) hit++;
  }
  return hit / query.length;
}

export interface SimilarResult {
  matches: SimilarMatch[];
  checked: number; // versions compared
  pending: number; // versions still without a fingerprint (queued now)
}

/** `phashes` (one per second) against every fingerprinted current version in the caller's libraries. */
export function similarTo(username: string, phashes: string[], exclude?: string): SimilarResult {
  const account = findUser(username);
  // as libraryRole: the Media Library switched off for the account means nothing of it, here too
  if (!phashes.length || (account && !mayUse(account, "media"))) return { matches: [], checked: 0, pending: 0 };
  const d = libraryDb();
  const rows = d
    .prepare(
      `SELECT a.id AS asset_id, a.library_id, a.title, v.id AS version_id, f.inline FROM assets a
       JOIN libraries l ON l.id = a.library_id JOIN asset_versions v ON v.id = a.current_version_id
       LEFT JOIN derivatives f ON f.version_id = v.id AND f.kind = 'fingerprint'
       WHERE l.workspace_id = ? AND a.trashed_at IS NULL AND a.kind = 'video' AND v.state = 'ready'`,
    )
    .all(homeOf(username)) as { asset_id: string; library_id: string; title: string; version_id: string; inline: string | null }[];
  const matches: SimilarMatch[] = [];
  let pending = 0;
  let checked = 0;
  // ponytail: every second against every second, O(clip × library); a BK-tree or LSH index when libraries reach thousands of hours
  for (const r of rows) {
    if (r.version_id === exclude) continue;
    if (!r.inline) {
      // computed once, then stored: the worker fingerprints it as the uploader
      enqueueJob(d, r.library_id, r.version_id, "fingerprint", (d.prepare("SELECT created_by FROM asset_versions WHERE id = ?").get(r.version_id) as { created_by: string }).created_by);
      pending++;
      continue;
    }
    const theirs = (JSON.parse(r.inline) as Fingerprint).phash;
    if (!theirs.length) continue;
    checked++;
    const overlap = overlapOf(phashes, theirs);
    if (overlap >= MIN_OVERLAP) {
      matches.push({ assetId: r.asset_id, libraryId: r.library_id, versionId: r.version_id, title: r.title, thumbUrl: `/api/library/media/${r.version_id}/thumb`, overlap });
    }
  }
  matches.sort((a, b) => b.overlap - a.overlap);
  return { matches: matches.slice(0, TOP), checked, pending };
}

const plain = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** A posted reel's speech as the voice check keeps it: lower case words, nothing else. */
export const speechWords = (words: string[]): string[] => words.map(plain).filter(Boolean);

const SHINGLE = 5; // words in a run that counts as the same speech

/** The share of the clip's words (0..100) that sit in a run of SHINGLE words the reel also says, and the longest such run in seconds. */
export function voiceOverlap(clip: TimedWord[], reel: string[]): { pct: number; longestS: number } {
  const said = new Set<string>();
  for (let i = 0; i + SHINGLE <= reel.length; i++) said.add(reel.slice(i, i + SHINGLE).join(" "));
  const words = clip.map((w) => ({ t: plain(w.w), s: w.s, e: w.e })).filter((w) => w.t);
  const hit = words.map(() => false);
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    if (said.has(words.slice(i, i + SHINGLE).map((w) => w.t).join(" "))) for (let k = i; k < i + SHINGLE; k++) hit[k] = true;
  }
  let shared = 0;
  let longestS = 0;
  let run = -1;
  for (let i = 0; i <= words.length; i++) {
    if (i < words.length && hit[i]) {
      shared++;
      if (run < 0) run = i;
    } else if (run >= 0) {
      longestS = Math.max(longestS, words[i - 1].e - words[run].s);
      run = -1;
    }
  }
  return { pct: words.length ? (shared / words.length) * 100 : 0, longestS };
}

export interface Voice {
  pct: number; // share of the clip's words said in the reel, 0..100
  longestS: number; // the longest run said in the reel, seconds of the clip
}

export interface PostedMatch {
  platform: SocialPlatform;
  handle: string;
  postId: string;
  url?: string;
  text: string;
  at: number;
  overlap: number;
  voice?: Voice;
}

export interface PostedResult {
  matches: PostedMatch[];
  checked: number; // posted videos compared by pictures
  pending: number; // posted videos with a media URL that are not fingerprinted yet
  voice: { on: boolean; checked: number; note: string }; // the voice check ran for the clip; posted reels compared by voice
}

/** The clip's speech for the voice check, or why there is none (shown as the note). */
export type ClipSpeech = { words: TimedWord[] } | { why: string };

/**
 * The caller's own posted videos (the connected accounts' posts whose login gave a media URL, see lib/connectors/prints.ts)
 * against a clip's pictures, with the library check's method and cutoffs. With the clip's speech, a reel is also
 * flagged when it shares more than QA.maxSharedPct of the clip's words or a run longer than QA.maxSharedRunS
 * (the editor's version limits). Only the caller's own accounts are read.
 */
export function similarToPosted(username: string, phashes: string[], speech?: ClipSpeech): PostedResult {
  const clip = speech && "words" in speech ? speech.words : undefined;
  const matches: PostedMatch[] = [];
  let checked = 0;
  let pending = 0;
  let voiced = 0;
  for (const a of readConnectors(username).accounts) {
    for (const p of a.posts ?? []) {
      const theirs = a.prints?.[p.id];
      if (!theirs && p.mediaUrl) pending++;
      const said = a.voices?.[p.id];
      const voice = clip && said?.length ? voiceOverlap(clip, said) : undefined;
      if (voice) voiced++;
      const pictures = !!theirs?.length && phashes.length > 0;
      if (pictures) checked++;
      const overlap = pictures ? overlapOf(phashes, theirs!) : 0;
      const voiceHit = !!voice && (voice.pct > QA.maxSharedPct || voice.longestS > QA.maxSharedRunS);
      if (overlap >= MIN_OVERLAP || voiceHit)
        matches.push({ platform: a.platform, handle: a.handle, postId: p.id, url: p.url, text: p.text.slice(0, 140), at: p.at, overlap, ...(voice ? { voice } : {}) });
    }
  }
  matches.sort((x, y) => y.overlap - x.overlap || (y.voice?.pct ?? 0) - (x.voice?.pct ?? 0));
  const note = !clip
    ? speech && "why" in speech ? speech.why : "Pictures only."
    : voiced ? `Voice compared with ${voiced} posted reel${voiced === 1 ? "" : "s"}.` : "Voice: no posted reel has a transcript yet.";
  return { matches: matches.slice(0, TOP), checked, pending, voice: { on: !!clip, checked: voiced, note } };
}

/** A library version against the rest of its workspace's libraries. Null when it has no fingerprint yet. */
export function similar(username: string, versionId: string): SimilarResult | null {
  const f = libraryDb()
    .prepare(
      `SELECT a.library_id, f.inline FROM derivatives f JOIN asset_versions v ON v.id = f.version_id JOIN assets a ON a.id = v.asset_id
       WHERE f.version_id = ? AND f.kind = 'fingerprint'`,
    )
    .get(versionId) as { library_id: string; inline: string | null } | undefined;
  if (!f?.inline || !libraryRole(username, f.library_id)) return null;
  return similarTo(username, (JSON.parse(f.inline) as Fingerprint).phash, versionId);
}
