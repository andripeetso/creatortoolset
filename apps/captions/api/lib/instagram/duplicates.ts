import { cosine, hashEmbed, tokenize } from "./embed";
import type { PostKind } from "./types";

export type DupKind = "repost" | "variation";

export interface DupMember {
  shortcode: string;
  captionPreview?: string;
  caption?: string;
  kind?: PostKind;
  postId?: string;
}

export interface LibraryDupHit {
  postId: string;
  username: string;
  shortcode: string;
  score: number;
  kind: DupKind;
}

export interface DupCluster {
  kind: DupKind;
  score: number;
  members: DupMember[];
  libraryHits: LibraryDupHit[];
}

const MIN_CAPTION = 12;
/** Short hooks and CTAs match too many reels if we treat them as 1:1 copies. */
const EXACT_MIN = 40;
const REPOST_MIN = 0.9;
const VARIATION_MIN = 0.72;

export function normalizeCaption(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function captionOf(m: DupMember): string {
  return (m.caption || m.captionPreview || "").trim();
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Reels recycle similar hooks; only identical captions count. Mixed kinds are a Reel version of the same post, not a repost. */
export function pairMode(a?: PostKind, b?: PostKind): "skip" | "exact" | "fuzzy" {
  if (a && b && a !== b) return "skip";
  if (!a || !b || a === "reel" || b === "reel") return "exact";
  return "fuzzy";
}

export function pairScore(
  a: string,
  b: string,
  mode: "exact" | "fuzzy" = "fuzzy",
): { score: number; kind?: DupKind } {
  const na = normalizeCaption(a);
  const nb = normalizeCaption(b);
  if (na.length < MIN_CAPTION || nb.length < MIN_CAPTION) return { score: 0 };
  if (na === nb) return na.length >= EXACT_MIN ? { score: 1, kind: "repost" } : { score: 0 };
  if (mode === "exact") return { score: 0 };
  const score = Math.max(cosine(hashEmbed(na), hashEmbed(nb)), jaccard(tokenize(na), tokenize(nb)));
  if (score >= REPOST_MIN) return { score, kind: "repost" };
  if (score >= VARIATION_MIN) return { score, kind: "variation" };
  return { score };
}

function roundScore(n: number): number {
  return Math.round(n * 100) / 100;
}

function libraryHitsFor(
  members: DupMember[],
  library: Array<{ id: string; shortcode: string; caption: string; username: string; kind?: PostKind }>,
  catalogCodes: Set<string>,
): LibraryDupHit[] {
  const hits: LibraryDupHit[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const caption = captionOf(m);
    for (const p of library) {
      if (!p.caption || catalogCodes.has(p.shortcode) || seen.has(p.id)) continue;
      const mode = pairMode(m.kind, p.kind);
      if (mode === "skip") continue;
      const { score, kind } = pairScore(caption, p.caption, mode);
      if (!kind) continue;
      seen.add(p.id);
      hits.push({
        postId: p.id,
        username: p.username,
        shortcode: p.shortcode,
        score: roundScore(score),
        kind,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 6);
}

export function detectReposts(
  catalog: DupMember[],
  library: Array<{ id: string; shortcode: string; caption: string; username: string; kind?: PostKind }>,
): DupCluster[] {
  const parent = catalog.map((_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]!);
    return parent[i]!;
  };
  const rootMeta = new Map<number, { score: number; kind: DupKind }>();
  for (let i = 0; i < catalog.length; i++) {
    const a = catalog[i]!;
    for (let j = i + 1; j < catalog.length; j++) {
      const b = catalog[j]!;
      const mode = pairMode(a.kind, b.kind);
      if (mode === "skip") continue;
      const { score, kind } = pairScore(captionOf(a), captionOf(b), mode);
      if (!kind) continue;
      const ra = find(i);
      const rb = find(j);
      parent[rb] = ra;
      const root = find(i);
      const prev = rootMeta.get(root);
      if (!prev || kind === "repost" || score > prev.score) {
        rootMeta.set(root, { score, kind: prev?.kind === "repost" ? "repost" : kind });
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < catalog.length; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }

  const catalogCodes = new Set(catalog.map((c) => c.shortcode));
  const clustered = new Set<string>();
  const clusters: DupCluster[] = [];

  for (const [root, idxs] of groups) {
    if (idxs.length < 2) continue;
    const meta = rootMeta.get(root) ?? { score: VARIATION_MIN, kind: "variation" as DupKind };
    const members = idxs.map((i) => catalog[i]!);
    for (const m of members) clustered.add(m.shortcode);
    clusters.push({
      kind: meta.kind,
      score: roundScore(meta.score),
      members,
      libraryHits: libraryHitsFor(members, library, catalogCodes),
    });
  }

  for (const m of catalog) {
    if (clustered.has(m.shortcode)) continue;
    const hits = libraryHitsFor([m], library, catalogCodes);
    if (!hits.length) continue;
    const top = hits[0]!;
    clusters.push({ kind: top.kind, score: top.score, members: [m], libraryHits: hits });
  }

  clusters.sort((a, b) => b.score - a.score || b.members.length - a.members.length);
  return clusters;
}
