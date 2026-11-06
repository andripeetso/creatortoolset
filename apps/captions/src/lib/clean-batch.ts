import type { CleanBatch } from "@contracts/clean-batch";
import type { EditOptions } from "@contracts/clean-edit";
import { saveCleanBlob } from "./clean-edit";
const base = "/api/clean/sources/batch";
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || "Batch export failed."), {
      status: response.status,
    });
  }
  return response;
}
export async function activeCleanBatch(): Promise<CleanBatch | null> {
  return (await request(base)).json();
}
export async function startCleanBatch(
  items: { sourceId: string; options: EditOptions }[],
): Promise<CleanBatch> {
  return (
    await request(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    })
  ).json();
}
export async function readCleanBatch(
  id: string,
  signal?: AbortSignal,
): Promise<CleanBatch> {
  return (
    await request(`${base}/${encodeURIComponent(id)}`, { signal })
  ).json();
}
export async function deleteCleanBatch(id: string) {
  await request(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function downloadCleanBatch(id: string) {
  const blob = await (
    await request(`${base}/${encodeURIComponent(id)}/download`)
  ).blob();
  saveCleanBlob(blob, "cleaned-videos.zip");
}
