import type { DatabaseSync } from "node:sqlite";
import type { Stretch } from "../../contracts/library";

/**
 * A video's shot descriptions (contracts/library.ts Stretch; table `stretches`, migration 21), in order. Where the
 * person wrote their own line for a stretch, theirs is the one returned. Empty until the library's `look` job ran.
 */
export function stretchesOf(db: DatabaseSync, versionId: string): Stretch[] {
  const rows = db
    .prepare("SELECT * FROM stretches WHERE version_id = ? ORDER BY seg, source = 'user' DESC")
    .all(versionId) as {
    version_id: string;
    seg: number;
    a: number;
    b: number;
    motion: number;
    action: number | null;
    clear: number | null;
    tags: string;
    text: string;
    ph: string | null;
    source: string;
    stamp: string | null;
  }[];
  const out: Stretch[] = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1]!.seg === r.seg) continue;
    let tags: string[] = [];
    try {
      const t = JSON.parse(r.tags) as unknown;
      if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === "string");
    } catch {
      /* a bad tags cell reads as none */
    }
    out.push({
      versionId: r.version_id,
      seg: r.seg,
      a: r.a,
      b: r.b,
      motion: r.motion,
      action: r.action ?? 0,
      clear: r.clear === 1,
      tags,
      text: r.text,
      ph: r.ph ?? "",
      source: r.source === "user" ? "user" : "ai",
      stamp: r.stamp ?? "",
    });
  }
  return out;
}
