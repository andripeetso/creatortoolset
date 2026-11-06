/** Hashed bag-of-words vectors so similar/meaning search works without a vector DB. */

export const EMBED_DIM = 256;
export const EMBED_MODEL = "hash-256";

export interface Embedding {
  model: string;
  at: number;
  vector: number[];
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s#]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  const mag = Math.sqrt(n);
  if (!mag) return v;
  return v.map((x) => x / mag);
}

export function hashEmbed(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    v[fnv1a(toks[i]) % EMBED_DIM] += 1;
    if (i + 1 < toks.length) v[fnv1a(`${toks[i]}_${toks[i + 1]}`) % EMBED_DIM] += 1.4;
  }
  return l2(v);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function embedSource(parts: Array<string | undefined | null>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join("\n");
}

export function makeEmbedding(text: string, at = Date.now()): Embedding {
  return { model: EMBED_MODEL, at, vector: hashEmbed(text) };
}
