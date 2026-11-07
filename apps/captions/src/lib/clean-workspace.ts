import type {
  CleanOptions,
  CleanSource,
  MetadataItem,
  UploadedComparison,
} from "@contracts/clean-workspace";

const base = "/api/clean/sources";
export async function cleanRequest(
  url: string,
  init?: RequestInit,
): Promise<CleanSource> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as
    (CleanSource & { error?: string }) | null;
  if (!response.ok || !body?.id)
    throw new Error(
      body?.error || "The server could not finish this operation.",
    );
  return body;
}
export const loadCleanSource = (id: string, signal?: AbortSignal) =>
  cleanRequest(`${base}/${encodeURIComponent(id)}`, { signal });
export const createCleanVersion = (id: string, options: CleanOptions) =>
  cleanRequest(`${base}/${id}/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
export const measureCleanVersion = (id: string, versionId: string) =>
  cleanRequest(`${base}/${id}/versions/${versionId}/measure`, {
    method: "POST",
  });
export const cleanMediaUrl = (
  id: string,
  versionId?: string,
  download = false,
) =>
  `${base}/${id}${versionId ? `/versions/${versionId}` : ""}/media${download ? "?download=1" : ""}`;

export function uploadCleanSource(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<CleanSource> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("POST", `${base}?name=${encodeURIComponent(file.name)}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as (CleanSource & { error?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) resolve(body);
      else reject(new Error(body?.error || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () =>
      reject(new Error("Upload interrupted. Retry to send the video again."));
    xhr.onabort = () =>
      reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

export async function deleteCleanSource(id: string) {
  const response = await fetch(`${base}/${id}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || "Could not remove this video session.");
  }
}

export const sameCleanOptions = (a: CleanOptions, b: CleanOptions) =>
  a.stripMetadata === b.stripMetadata && a.unique === b.unique;
export function removedMetadata(before: MetadataItem[], after: MetadataItem[]) {
  return before.filter(
    (item) =>
      !after.some(
        (other) =>
          item.where === other.where &&
          item.key === other.key &&
          item.value === other.value,
      ),
  );
}

export async function compareCleanSources(
  id: string,
  otherId: string,
): Promise<UploadedComparison> {
  const response = await fetch(`${base}/${encodeURIComponent(id)}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ otherId }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Could not compare these videos.");
  return body;
}
