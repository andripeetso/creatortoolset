import type { LibraryAssetRef, LibraryFacet, LibraryPolicy, LibrarySlot, LibrarySource, LibraryViewer } from "../../contracts/library-source";

import { grantedTo } from "./grants";

/**
 * The Media Library's source and policy registry (contracts/library-source.ts). Registration never touches the
 * database, so the plug-in loader (api/lib/plugin.ts) can register into it at boot. The built-in policy reads the
 * grant table only when asked.
 *
 * The public storage libraries are the built-in source, and its policy is owner-only, plus the collections the owner
 * granted to an account (grants.ts). A member sees nothing else until a policy says otherwise. A plug-in adds sources,
 * policies (second gates, for its own sources or for the built-in one) and facets. A policy that is not registered
 * refuses everything.
 */

/** The source of every library on the public storage (local, S3 and Bunny alike). */
export const LIBRARY_SOURCE = "library";

/** The built-in policy: the library's owner sees every asset; anyone else only an asset in a collection granted to them. */
const ownerOrGranted = (viewer: LibraryViewer, asset: LibraryAssetRef): boolean =>
  viewer.role === "owner" || grantedTo(viewer.username, asset.assetId);

const sources = new Map<string, LibrarySource>([[LIBRARY_SOURCE, { id: LIBRARY_SOURCE, label: "Library" }]]);
const policies = new Map<string, LibraryPolicy[]>([[LIBRARY_SOURCE, [{ sourceId: LIBRARY_SOURCE, canSee: ownerOrGranted }]]]);
const facets = new Map<string, LibraryFacet>();

/**
 * Throws what registering these slots, in this order, on top of what is registered now would throw: a repeated source or
 * facet, or a policy for an unknown source. Registers nothing, so a plug-in can be refused before anything is mounted.
 */
export function checkLibrarySlots(slots: [plugin: string, slot: LibrarySlot][]): void {
  const haveSources = new Set(sources.keys());
  const haveFacets = new Set(facets.keys());
  for (const [plugin, slot] of slots) {
    if (slot.source) {
      if (haveSources.has(slot.source.id)) throw new Error(`plug-in ${plugin}: library source "${slot.source.id}" is already registered`);
      haveSources.add(slot.source.id);
    }
    for (const p of slot.policies ?? []) {
      if (!haveSources.has(p.sourceId)) throw new Error(`plug-in ${plugin}: library policy for unknown source "${p.sourceId}"`);
    }
    for (const f of slot.facets ?? []) {
      if (haveFacets.has(f.key)) throw new Error(`plug-in ${plugin}: library facet "${f.key}" is already registered`);
      haveFacets.add(f.key);
    }
  }
}

/** Adds a plug-in's source, policies and facets. Throws on a repeated source or facet, or a policy for an unknown source. */
export function registerLibrarySlot(plugin: string, slot: LibrarySlot): void {
  checkLibrarySlots([[plugin, slot]]);
  if (slot.source) {
    sources.set(slot.source.id, slot.source);
    policies.set(slot.source.id, []);
  }
  for (const p of slot.policies ?? []) policies.get(p.sourceId)!.push(p);
  for (const f of slot.facets ?? []) facets.set(f.key, f);
}

/**
 * Whether the viewer may see the asset. False when its source has no policy, and when any policy of the source says
 * no. A policy that throws counts as no: a broken plug-in narrows the library, it never widens it.
 */
export async function canSee(viewer: LibraryViewer, asset: LibraryAssetRef): Promise<boolean> {
  const list = policies.get(asset.sourceId);
  if (!list?.length) return false;
  for (const p of list) {
    try {
      if ((await p.canSee(viewer, asset)) !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether a library source is registered (the built-in one included). Refs for an unknown source are not made. */
export const hasLibrarySource = (id: string): boolean => sources.has(id);

/** A registered source by id (the built-in one included), or undefined. */
export const sourceById = (id: string): LibrarySource | undefined => sources.get(id);

/** The plug-in sources (not the built-in library) a viewer may see at all: their policies answer for a source-level probe. */
export async function sourcesVisibleTo(viewer: LibraryViewer): Promise<LibrarySource[]> {
  const out: LibrarySource[] = [];
  for (const s of sources.values()) {
    if (s.id === LIBRARY_SOURCE || !s.list) continue;
    if (await canSee(viewer, { sourceId: s.id, libraryId: "", assetId: "", versionId: "" })) out.push(s);
  }
  return out;
}

/** A library asset's reference for the policies: the built-in source, the library, the asset and its current version. */
export const assetRef = (libraryId: string, assetId: string, versionId: string): LibraryAssetRef => ({
  sourceId: LIBRARY_SOURCE,
  libraryId,
  assetId,
  versionId,
});

/** The SQL that narrows an asset list by the facets a viewer picked. Unknown keys and empty values are dropped. */
export function facetClauses(picked: Record<string, string[]>): { sql: string; params: (string | number)[] }[] {
  return Object.entries(picked)
    .filter(([key, values]) => facets.has(key) && values.length)
    .map(([key, values]) => facets.get(key)!.where(values));
}

/** The plug-in source that is the install's Media Library, when one says so (LibrarySource.main). */
export const mainSource = (): LibrarySource | undefined => [...sources.values()].find((s) => s.main);

/** Test seam: forget every plug-in's registrations, leaving the built-in source and its owner-only policy. */
export function resetLibrarySlots(): void {
  sources.clear();
  policies.clear();
  facets.clear();
  sources.set(LIBRARY_SOURCE, { id: LIBRARY_SOURCE, label: "Library" });
  policies.set(LIBRARY_SOURCE, [{ sourceId: LIBRARY_SOURCE, canSee: ownerOrGranted }]);
}
