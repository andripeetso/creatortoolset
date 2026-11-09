import type { CatalogGraph, CatalogItem } from "./types";

export const DEFAULT_CATALOG_COUNT = 12;
export const MAX_CATALOG_COUNT = 200;

export function parseCatalogCount(raw: unknown, fallback = DEFAULT_CATALOG_COUNT): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_CATALOG_COUNT, Math.round(n)));
}

/** Newest takenAt in a catalog — watermark so the next pull does not walk older pages. */
export function catalogNewestAt(items: CatalogItem[]): number | undefined {
  let max = 0;
  for (const row of items) {
    if (row.takenAt > max) max = row.takenAt;
  }
  return max > 0 ? max : undefined;
}

export function catalogCrossedSince(items: CatalogItem[], since?: number): boolean {
  if (!since) return false;
  return items.some((row) => row.takenAt > 0 && row.takenAt < since);
}

function countsChanged(
  a: CatalogItem["counts"] | undefined,
  b: CatalogItem["counts"] | undefined,
): boolean {
  if (!a || !b) return false;
  return a.plays !== b.plays || a.likes !== b.likes || a.comments !== b.comments;
}

/** The fresh Graph block wins; it keeps when insights were last read if this fetch had none. */
function mergeGraph(old: CatalogGraph | undefined, next: CatalogGraph | undefined): CatalogGraph | undefined {
  if (!next) return old;
  if (next.insightsAt !== undefined || old?.insightsAt === undefined) return next;
  return { ...next, insightsAt: old.insightsAt };
}

/** A listing row carries feed metrics only; reel metrics (watch time, follows, profile visits) keep from the stored row. */
function carryInsights(old: CatalogItem["insights"], next: CatalogItem["insights"]): CatalogItem["insights"] {
  if (!next) return old;
  return old ? { ...old, ...next } : next;
}

/** Days after which a row's insights are read again. A reel read inside this window is not re-read on each pull. */
export const INSIGHT_REREAD_MS = 7 * 24 * 60 * 60 * 1000;

/** Graph ids whose insights need a read: never read, or last read over INSIGHT_REREAD_MS ago. mergeGraph keeps a stored row's read time, so known reels are skipped while fresh. */
export function insightIdsToRead(items: CatalogItem[], now = Date.now()): string[] {
  return items
    .filter((row) => row.graphId && row.graph && (!row.graph.insightsAt || now - row.graph.insightsAt > INSIGHT_REREAD_MS))
    .map((row) => row.graphId!);
}

function keepMarks(old: CatalogItem | undefined, row: CatalogItem): CatalogItem {
  if (!old) return row;
  return {
    ...row,
    starred: old.starred ?? row.starred,
    postId: old.postId ?? row.postId,
    ideaStatus: old.ideaStatus ?? row.ideaStatus,
    rank: old.rank ?? row.rank,
    graphId: row.graphId ?? old.graphId,
    graph: mergeGraph(old.graph, row.graph),
    visibility: row.visibility ?? old.visibility,
    visibilityBasis: row.visibility ? row.visibilityBasis : old.visibilityBasis,
    isSharedToFeed: row.isSharedToFeed ?? old.isSharedToFeed,
    insights: carryInsights(old.insights, row.insights),
    caption: row.caption ?? old.caption,
    prevCounts: countsChanged(old.counts, row.counts) ? old.counts : old.prevCounts,
  };
}

/** Newer rows win on stats; keep research marks and library links from the old row. */
export function mergeCatalog(prev: CatalogItem[], next: CatalogItem[]): CatalogItem[] {
  const map = new Map<string, CatalogItem>();
  for (const row of prev) map.set(row.shortcode, row);
  for (const row of next) map.set(row.shortcode, keepMarks(map.get(row.shortcode), row));
  return [...map.values()].sort((a, b) => b.takenAt - a.takenAt);
}

/** Refresh counts/thumbs on known rows only — stats must not grow the catalog. */
export function mergeCatalogCounts(prev: CatalogItem[], next: CatalogItem[]): CatalogItem[] {
  const fresh = new Map(next.map((row) => [row.shortcode, row]));
  return prev.map((old) => {
    const row = fresh.get(old.shortcode);
    if (!row) return old;
    return keepMarks(old, {
      ...old,
      kind: row.kind || old.kind,
      takenAt: row.takenAt || old.takenAt,
      thumbnailUrl: row.thumbnailUrl || old.thumbnailUrl,
      captionPreview: row.captionPreview || old.captionPreview,
      caption: row.caption ?? old.caption,
      graphId: row.graphId ?? old.graphId,
      graph: row.graph ?? old.graph,
      visibility: row.visibility ?? old.visibility,
      visibilityBasis: row.visibility ? row.visibilityBasis : old.visibilityBasis,
      isSharedToFeed: row.isSharedToFeed ?? old.isSharedToFeed,
      insights: carryInsights(old.insights, row.insights),
      counts: row.counts,
    });
  });
}
