import type { Edit } from "../../contracts/editor";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { readStep, saveStep, type EditMeta } from "./store";

/**
 * Edit in passes (EditStyleCopy.passes): each version's first cut goes to Review and waits; approving that cut in Review
 * (approvePass) or Carry on (POST /api/editor/:id/pass, kept for older apps) queues its next pass, which ends in a new
 * preview and waits again. What runs after each step is
 * nextFor's (engine.ts). Which passes a version has had is kept in passes.json beside the edit: { [variant]: ["broll", …] }.
 */

export type Pass = "broll" | "cards";

/** A pass in the Review version's words (its `next`: the Approve button reads "Approve · add B-roll"). */
export const PASS_WORD: Record<Pass, string> = { broll: "B-roll", cards: "cards" };

/** The passes after the first cut, in order: B-roll when the edit has a folder, cards when its style names an animation style. */
const passesOf = (e: EditMeta): Pass[] =>
  // an edit of moments has no pass after its first cut: a one-line cut takes no cutaway and no card (broll.ts, cards/place.ts)
  e.style?.passes && !e.moments ? [...(e.brollCollectionId ? (["broll"] as const) : []), ...(e.style.animation ? (["cards"] as const) : [])] : [];

export const passesDone = (id: string, variant: string): string[] => readStep(id, "passes")?.[variant] ?? [];

/** The version's next pass; null when it has had them all, or the edit is not in passes. */
export const nextPass = (e: EditMeta, variant: string): Pass | null => passesOf(e).find((p) => !passesDone(e.id, variant).includes(p)) ?? null;

/** Records each version's pass as done (Carry on queued it). */
export async function markPasses(id: string, queued: Record<string, Pass>): Promise<void> {
  const all = readStep(id, "passes") ?? {};
  for (const [v, p] of Object.entries(queued)) all[v] = [...(all[v] ?? []), p];
  await saveStep(id, "passes", all);
}

/**
 * Its cut `n` was approved in Review: the version's next pass is queued, once. Only for the cut filed last, while that cut
 * still names this pass as next (a second press, or one on an older cut, finds the pass recorded already) and nothing of
 * the version runs. True when it queued one.
 */
export async function approvePass(e: EditMeta, variant: string, next: string | undefined, actor: string | null): Promise<boolean> {
  const p = nextPass(e, variant);
  if (!p || next !== PASS_WORD[p]) return false;
  const db = libraryDb();
  if (db.prepare("SELECT 1 FROM edit_jobs WHERE version_id = ? AND state IN ('queued', 'running')").get(`${e.id}:${variant}`)) return false;
  await markPasses(e.id, { [variant]: p });
  enqueueJob(db, e.workspaceId, `${e.id}:${variant}`, p, actor, true, "edit_jobs");
  return true;
}

/** A version cut again starts its passes over. Nothing is written for a version with no record. */
export async function clearPasses(id: string, variant: string): Promise<void> {
  const all = readStep(id, "passes");
  if (!all?.[variant]) return;
  delete all[variant];
  await saveStep(id, "passes", all);
}

/** The edit page's line: the earliest pass a drafted version still has, and whether the edit waits for Carry on. */
export function passesView(e: EditMeta, drafts: string[], busy: boolean): Edit["passes"] {
  if (!e.style?.passes) return undefined;
  const left = new Set(drafts.map((n) => nextPass(e, n)));
  const next = left.has("broll") ? "broll" : left.has("cards") ? "cards" : null;
  return { waiting: !busy && !!next, next };
}
