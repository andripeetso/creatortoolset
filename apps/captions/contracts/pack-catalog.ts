/**
 * The community catalog's shapes (api/pack-catalog.ts), as the shared catalog at PACK_CATALOG_URL answers them.
 * Shared by the API and the browser. A pack's own format is contracts/packs.ts.
 */
import type { InstalledPack, Pack, PackLevel, PackSlot } from "./packs";

/** One listed pack: the latest approved version (GET /api/pack-catalog/public). */
export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  description: string;
  niche?: string;
  homepage?: string;
  level: PackLevel;
  /** Shipped with the app (apps/captions/packs/), listed without review. */
  official: boolean;
  installs: number;
  /** When the listed version was approved (built-in packs: the file's time). Newest first in the list. */
  publishedAt: number;
  /** `home`: it carries a Home layout (a catalog from before layouts leaves it out). */
  contains: { instructions: PackSlot[]; frameworks: number; captionStyles: number; designSystems: number; home?: boolean };
}

/** GET /api/pack-catalog/public/:id. A delisted pack answers 410 with `{error, reason}` instead. */
export interface CatalogDetail {
  entry: CatalogEntry;
  pack: Pack;
  /** Approved versions, newest first. */
  versions: string[];
}

/**
 * GET /api/pack-catalog/updates: one row per installed pack with a newer approved version, and one per pack the
 * catalog delisted (`latest: null`, with the reason).
 */
export interface UpdateRow {
  id: string;
  installed: string;
  latest: string | null;
  delisted?: string;
}

/** POST /api/pack-catalog/:id/install. */
export interface CatalogInstallResult {
  installed: InstalledPack;
  kept: number;
}
