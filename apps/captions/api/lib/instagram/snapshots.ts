import { readFile, writeFile } from "node:fs/promises";
import type { Snapshot } from "./types";

export interface SnapshotDiff {
  elapsedMs: number;
  likes?: number;
  comments?: number;
  plays?: number;
  followers?: number;
}

export function snapshotFromCounts(
  counts: { likes?: number; comments?: number; plays?: number },
  source: Snapshot["source"],
  extra: Partial<Snapshot> = {},
): Snapshot {
  return {
    at: Date.now(),
    source,
    likes: counts.likes,
    comments: counts.comments,
    plays: counts.plays,
    ...extra,
  };
}

export async function loadSnapshots(file: string): Promise<Snapshot[]> {
  try {
    const raw = JSON.parse(await readFile(file, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSnapshot);
  } catch {
    return [];
  }
}

export async function appendSnapshot(file: string, snap: Snapshot): Promise<Snapshot[]> {
  const list = await loadSnapshots(file);
  const prev = list[list.length - 1];
  if (prev && sameNumbers(prev, snap) && snap.at - prev.at < 60_000) return list;
  list.push(snap);
  await writeFile(file, JSON.stringify(list));
  return list;
}

export function diffSnapshots(from: Snapshot, to: Snapshot): SnapshotDiff {
  return {
    elapsedMs: Math.max(0, to.at - from.at),
    likes: delta(from.likes, to.likes),
    comments: delta(from.comments, to.comments),
    plays: delta(from.plays, to.plays),
    followers: delta(from.followers, to.followers),
  };
}

function delta(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return b - a;
}

function sameNumbers(a: Snapshot, b: Snapshot): boolean {
  return (
    a.likes === b.likes &&
    a.comments === b.comments &&
    a.plays === b.plays &&
    a.followers === b.followers &&
    a.following === b.following &&
    a.posts === b.posts
  );
}

function isSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== "object") return false;
  const rec = v as Snapshot;
  return (
    typeof rec.at === "number" &&
    (rec.source === "apify" || rec.source === "session" || rec.source === "graph")
  );
}
