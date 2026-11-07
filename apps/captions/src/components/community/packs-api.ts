import type { InstalledPack, Pack, PackLevel } from "@contracts/packs";
import { json } from "@/lib/pack-catalog";

/** Calls for the account's own packs (api/packs.ts). The catalog's are in src/lib/pack-catalog.ts. */
const call = async <T,>(url: string, method = "GET", body?: unknown): Promise<T> =>
  json<T>(
    await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

export const listInstalled = () => call<InstalledPack[]>("/api/packs");
export const setPackOn = (id: string, on: boolean, projectId?: string) =>
  call<InstalledPack>(`/api/packs/${encodeURIComponent(id)}`, "PATCH", { on, projectId });
/** null = every project. */
export const setPackProjects = (id: string, projectIds: string[] | null) =>
  call<InstalledPack>(`/api/packs/${encodeURIComponent(id)}`, "PATCH", { projectIds });
export const removePack = (id: string) => call<{ removed: boolean; kept: number }>(`/api/packs/${encodeURIComponent(id)}`, "DELETE");
/** Build a pack from the person's own frameworks and caption styles. Refusals throw a CatalogError with `problems`. */
export const exportPack = (fields: Record<string, unknown>) => call<{ pack: Pack; level: PackLevel }>("/api/packs/export", "POST", fields);
