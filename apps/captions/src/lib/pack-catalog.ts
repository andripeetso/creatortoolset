/**
 * Client for the community catalog's read side (api/pack-catalog.ts). The shapes are contracts/pack-catalog.ts.
 * Every failed request throws a CatalogError with the server's message, its problems list, and its publishAt link
 * (publishing happens on the catalog's own site) or reason (a delisted pack).
 */
import type { CatalogDetail, CatalogEntry, CatalogInstallResult, UpdateRow } from "@contracts/pack-catalog";
import type { Pack, PackSlot } from "@contracts/packs";

export class CatalogError extends Error {
  status: number;
  problems: string[];
  publishAt?: string;
  reason?: string;

  constructor(message: string, status: number, problems: string[] = [], publishAt?: string, reason?: string) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
    this.problems = problems;
    this.publishAt = publishAt;
    this.reason = reason;
  }
}

export async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as {
    error?: string;
    problems?: string[];
    publishAt?: string;
    reason?: string;
  } | null;
  if (!res.ok) throw new CatalogError(j?.error || `Request failed (${res.status})`, res.status, j?.problems, j?.publishAt, j?.reason);
  return j as T;
}

const jsonInit = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Browse the catalog: a search over name, description, niche and author; `slot` = packs with instructions for it. */
export async function browseCatalog(opts: { q?: string; slot?: PackSlot } = {}): Promise<CatalogEntry[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.slot) qs.set("slot", opts.slot);
  const suffix = qs.size ? `?${qs}` : "";
  return json<CatalogEntry[]>(await fetch(`/api/pack-catalog/public${suffix}`));
}

/** One listed pack with its full text. A delisted pack throws a CatalogError with status 410 and `reason`. */
export async function catalogPack(id: string): Promise<CatalogDetail> {
  return json<CatalogDetail>(await fetch(`/api/pack-catalog/public/${encodeURIComponent(id)}`));
}

/** Only the detail, remembered for the session: a card's preview and the detail page ask once. */
const detailCache = new Map<string, Promise<CatalogDetail>>();
// ponytail: each visible card fetches its pack once; the list endpoint should carry a preview when the catalog grows.
export function cachedCatalogPack(id: string): Promise<CatalogDetail> {
  let hit = detailCache.get(id);
  if (!hit) {
    hit = catalogPack(id);
    detailCache.set(id, hit);
    hit.catch(() => detailCache.delete(id));
  }
  return hit;
}

/** Install the latest approved version into the signed-in account: every project when `projectIds` is empty or missing. */
export async function installCatalogPack(id: string, projectIds?: string[]): Promise<CatalogInstallResult> {
  return json<CatalogInstallResult>(await fetch(`/api/pack-catalog/${encodeURIComponent(id)}/install`, jsonInit({ projectIds })));
}

/** Installed packs with a newer approved version, and the ones the catalog delisted (marked on this account). */
export async function catalogUpdates(): Promise<UpdateRow[]> {
  return json<UpdateRow[]>(await fetch("/api/pack-catalog/updates"));
}

/** This server only reads the catalog: it answers 409 with `publishAt`, the catalog's site, where packs are sent. */
export async function submitPack(pack: Pack): Promise<unknown> {
  return json<unknown>(await fetch("/api/pack-catalog/submit", jsonInit({ pack, rights: true })));
}
