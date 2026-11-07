import type { InstalledPack, Pack, PackCheck, PackLevel } from "@contracts/packs";

/** Calls for Settings → Packs (api/packs.ts). */

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new ApiError(typeof j.error === "string" ? j.error : `Request failed (${r.status})`, r.status, j);
  return j as T;
}

export const listInstalled = () => call<InstalledPack[]>("/api/packs");
export const checkPackFile = (pack: unknown) => call<PackCheck & { problems: string[] }>("/api/packs/check", "POST", pack);
export const installPack = (pack: Pack, projectId?: string) =>
  call<{ installed: InstalledPack; kept: number }>("/api/packs/install", "POST", { pack, projectId });
export const setPackOn = (id: string, on: boolean, projectId?: string) =>
  call<InstalledPack>(`/api/packs/${encodeURIComponent(id)}`, "PATCH", { on, projectId });
export const removePack = (id: string) => call<{ removed: boolean; kept: number }>(`/api/packs/${encodeURIComponent(id)}`, "DELETE");
export const exportPack = (fields: Record<string, unknown>) =>
  call<{ pack: Pack; level: PackLevel }>("/api/packs/export", "POST", fields);

/** The person's own items to share (Share as pack): frameworks and caption styles. */
export const listOwnFrameworks = () => call<Array<{ id: string; name: string; owner: string }>>("/api/workshop/frameworks");
export const listOwnPresets = () => call<Array<{ id: string; name: string; owner: string; scope: string; kind?: string }>>("/api/presets");
