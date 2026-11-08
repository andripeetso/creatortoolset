import { SESSION_FINISHED, type Document, type SessionMeta } from "./types";

/**
 * How much of the AI's text the author kept as it was. A block the author edits becomes the author's ("user"), so in a finished piece the share of
 * characters still marked "ai" is what the author let stand. Higher = the AI wrote closer to what the author'd post.
 * Measured on pieces of sessions the author moved on with (In Production, Ready, Published, or posted), by the week
 * the session started, from the files as they are: it works backwards over every session already there.
 */
export function keptShare(doc: Pick<Document, "kind" | "blocks" | "hooks" | "caption">): number | undefined {
  if (doc.kind === "notes") return undefined;
  const parts = [...doc.blocks, ...(doc.hooks ?? []), ...(doc.caption ? [doc.caption] : [])].filter((b) => b.text.trim());
  const total = parts.reduce((n, b) => n + b.text.trim().length, 0);
  if (!total) return undefined;
  return parts.filter((b) => b.author === "ai").reduce((n, b) => n + b.text.trim().length, 0) / total;
}

export const finished = (m: Pick<SessionMeta, "status" | "posted">) => !!m.posted || SESSION_FINISHED.includes(m.status ?? "draft");

/** Monday of the week, as YYYY-MM-DD (UTC). */
const weekOf = (ms: number) => {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export interface KeptWeek {
  week: string;
  pieces: number;
  /** Median share of AI text kept, 0–1. */
  median: number;
}

export function keptByWeek(pieces: Array<{ at: number; share: number }>): KeptWeek[] {
  const by = new Map<string, number[]>();
  for (const p of pieces) by.set(weekOf(p.at), [...(by.get(weekOf(p.at)) ?? []), p.share]);
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, xs]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return { week, pieces: s.length, median: Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 100) / 100 };
    });
}
