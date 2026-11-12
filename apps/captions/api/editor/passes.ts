import type { Edit } from "../../contracts/editor";
import { readStep, saveStep, type EditMeta } from "./store";

/**
 * Edit in passes (EditStyleCopy.passes): each version's first cut goes to Review and waits; Carry on (POST
 * /api/editor/:id/pass) queues its next pass, which ends in a new preview and waits again. What runs after each step is
 * nextFor's (engine.ts). Which passes a version has had is kept in passes.json beside the edit: { [variant]: ["broll", …] }.
 */

export type Pass = "broll" | "cards";

/** The passes after the first cut, in order: B-roll when the edit has a folder, cards when its style names an animation style. */
const passesOf = (e: EditMeta): Pass[] =>
  e.style?.passes ? [...(e.brollCollectionId ? (["broll"] as const) : []), ...(e.style.animation ? (["cards"] as const) : [])] : [];

export const passesDone = (id: string, variant: string): string[] => readStep(id, "passes")?.[variant] ?? [];

/** The version's next pass; null when it has had them all, or the edit is not in passes. */
export const nextPass = (e: EditMeta, variant: string): Pass | null => passesOf(e).find((p) => !passesDone(e.id, variant).includes(p)) ?? null;

/** Records each version's pass as done (Carry on queued it). */
export async function markPasses(id: string, queued: Record<string, Pass>): Promise<void> {
  const all = readStep(id, "passes") ?? {};
  for (const [v, p] of Object.entries(queued)) all[v] = [...(all[v] ?? []), p];
  await saveStep(id, "passes", all);
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
