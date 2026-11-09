/**
 * The AI Editor's animated cards: the `editor.cards` slot of installed packs, and nothing else.
 *
 * Only a level 1 pack (one that carries drawing code, a motion kit) adds to the card prompt; a level 0 pack's text in
 * that slot is ignored. The server never runs a kit. Drawing happens on the user's Mac (apps/mac KitRunner.swift), in a
 * web view with no network and no file access, and this module imports nothing that renders.
 */
import type { InstalledPack, PackSlot } from "../../contracts/packs";
import { renderPackInstructions } from "../lib/packs";

export const CARDS_SLOT: PackSlot = "editor.cards";

/** The card prompt's pack text, from installed level 1 packs only (empty when none adds any). */
export function cardsInstructions(packs: InstalledPack[], projectId?: string | null): string {
  return renderPackInstructions(
    packs.filter((p) => p.level === 1),
    CARDS_SLOT,
    projectId,
  );
}
