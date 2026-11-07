import { PACK_SLOTS, type Pack, type PackSlot } from "@contracts/packs";

export const LICENCES = ["CC-BY-4.0", "CC0-1.0", "MIT", "Other"] as const;

/** The slots this app adds to a prompt, in order. editor.cards is in the format but this app draws no cards. */
export const USED_SLOTS = (Object.keys(PACK_SLOTS) as PackSlot[]).filter((s) => s !== "editor.cards");

/** What a pack adds here, in the order the screens show it (design systems and unused slots are left out). */
export interface PackContents {
  slots: Array<{ slot: PackSlot; label: string; text: string }>;
  frameworks: Array<{ name: string; role: string }>;
  captionStyles: string[];
}

export function packContents(pack: Partial<Pick<Pack, "instructions" | "frameworks" | "captionStyles">>): PackContents {
  const instructions = pack.instructions ?? {};
  return {
    slots: USED_SLOTS.filter((s) => instructions[s]).map((slot) => ({ slot, label: PACK_SLOTS[slot], text: instructions[slot] ?? "" })),
    frameworks: (pack.frameworks ?? []).map((f) => ({ name: f.name, role: f.role })),
    captionStyles: (pack.captionStyles ?? []).map((s) => s.name),
  };
}

/** Share form: the id a pack gets from its name ("Punchy Hooks" → "punchy-hooks"). */
export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
