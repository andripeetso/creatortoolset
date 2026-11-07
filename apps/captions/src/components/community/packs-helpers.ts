import { PACK_SLOTS, type InstalledPack, type Pack, type PackSlot } from "@contracts/packs";
import type { CatalogEntry } from "@contracts/pack-catalog";

export const LICENCES = ["CC-BY-4.0", "CC0-1.0", "MIT"] as const;

/** The slots this app adds to a prompt, in order. editor.cards is in the format but this app draws no cards. */
export const USED_SLOTS: PackSlot[] = (Object.keys(PACK_SLOTS) as PackSlot[]).filter((s) => s !== "editor.cards");

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

/** "2 frameworks", "1 install": the count lines on the cards. */
export function countLabel(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The sections of Community: each place in this app a pack works. */
export const PACK_KINDS = {
  frameworks: "Writing frameworks",
  guides: "Writing guides",
  captions: "Caption styles",
  editing: "Editing styles",
  analyzer: "Analyzer guides",
} as const;
export type KindId = keyof typeof PACK_KINDS;

export interface PackKind {
  id: KindId;
  label: string;
  /** Frameworks or styles, or instruction places for the guide kinds. */
  count?: number;
}

/** The sections a catalog entry shows in (a pack with several kinds shows in each), counted from its `contains`. */
export function packKinds(c: CatalogEntry["contains"]): PackKind[] {
  const slots = c.instructions.filter((s) => USED_SLOTS.includes(s));
  const countSlots = (prefix: string) => slots.filter((s) => s.startsWith(prefix)).length;
  const kinds: PackKind[] = [];
  const add = (id: KindId, count?: number) => kinds.push({ id, label: PACK_KINDS[id], count });
  if (c.frameworks) add("frameworks", c.frameworks);
  if (countSlots("workshop.")) add("guides", countSlots("workshop."));
  if (c.captionStyles) add("captions", c.captionStyles);
  else if (slots.includes("captions.lines")) add("captions");
  if (countSlots("editor.")) add("editing", countSlots("editor."));
  if (slots.includes("analyzer.ideas")) add("analyzer", 1);
  return kinds;
}

/** "Writing frameworks · 21, Writing guides · 2" */
export const kindLine = (kinds: PackKind[]): string =>
  kinds.map((k) => (k.count === undefined ? k.label : `${k.label} · ${k.count}`)).join(", ");

/** The projects an installed pack is limited to; empty = every project. Before projectIds, a pack had one projectId. */
export function packProjects(p: Pick<InstalledPack, "projectIds" | "projectId">): string[] {
  return p.projectIds?.length ? p.projectIds : p.projectId ? [p.projectId] : [];
}

/** The pack id an item gets from its name ("Punchy Hooks" → "punchy-hooks"). */
export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
