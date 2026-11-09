import type { AssetCard } from "@contracts/library";
import type { LibraryFacetScope, LibraryWebSlot } from "@contracts/library-source";
import { webPlugins } from "../plugins.gen";

/**
 * The Media Library's plug-in slots in the browser: the facets and badges each web plug-in adds (LibraryWebSlot).
 * Read once from the generated registry; with no plug-in folder both lists are empty and the page is the generic one.
 */
const SLOTS: LibraryWebSlot[] = webPlugins.flatMap((p) => (p.library ? [p.library] : []));

type Facet = NonNullable<LibraryWebSlot["facets"]>[number];

/** Whether a facet shows on a page: its scope is that page, or "both". A facet with no scope is a library facet. */
const inScope = (f: Facet, page: "library" | "finals") => {
  const scope: LibraryFacetScope = f.scope ?? "library";
  return scope === "both" || scope === page;
};

/** The sidebar facets a page shows: the Media Library's ("library") or Finals' ("finals"). */
export const libraryFacets = (page: "library" | "finals") => SLOTS.flatMap((s) => s.facets ?? []).filter((f) => inScope(f, page));

/** The picks that belong to a page: a pick on a facet the page does not show is dropped, so it never narrows that page. */
export function pickedFor(picked: Record<string, string[]>, page: "library" | "finals"): Record<string, string[]> {
  const keys = new Set(libraryFacets(page).map((f) => f.key));
  return Object.fromEntries(Object.entries(picked).filter(([k]) => keys.has(k)));
}

export const libraryBadges = (card: AssetCard) => SLOTS.flatMap((s) => s.badges?.(card) ?? []);
