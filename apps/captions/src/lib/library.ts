import type { AssetPage, LibrarySummary, SearchQuery } from "@contracts/library";

/** The Media Library's calls to api/library/routes.ts, and the chunked upload that follows its offset protocol. */

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
}

export const listLibraries = () =>
  fetch("/api/library")
    .then((r) => json<{ libraries: LibrarySummary[] }>(r))
    .then((x) => x.libraries);

export const createLibrary = (name: string) =>
  fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then(
    (r) => json<LibrarySummary>(r),
  );

export function listAssets(libraryId: string, q: SearchQuery & { cursor?: string }): Promise<AssetPage> {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.kind?.length) p.set("kind", q.kind.join(","));
  if (q.cursor) p.set("cursor", q.cursor);
  return fetch(`/api/library/${libraryId}/assets?${p}`).then((r) => json<AssetPage>(r));
}

export interface UploadResult {
  assetId?: string;
  duplicateOf?: string;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * One file into the library: create the upload, then PATCH chunks from the offset the server reports. A 409 gives the
 * offset to resume from; a dropped request asks HEAD where the server stopped. Five failures in a row give up.
 */
export async function uploadFile(libraryId: string, file: File, onProgress: (sent: number) => void): Promise<UploadResult> {
  const init = await fetch(`/api/library/${libraryId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.name, size: file.size }),
  }).then((r) => json<{ id: string; offset: number; chunkSize: number }>(r));
  const url = `/api/library/uploads/${init.id}`;
  let offset = init.offset;
  let failures = 0;
  while (offset < file.size) {
    try {
      const r = await fetch(url, {
        method: "PATCH",
        headers: { "upload-offset": String(offset) },
        body: file.slice(offset, Math.min(file.size, offset + init.chunkSize)),
      });
      if (r.status === 409) offset = ((await r.json()) as { offset: number }).offset;
      else if (r.ok) offset = Number(r.headers.get("upload-offset"));
      else throw new Error(`Upload failed (${r.status})`);
      failures = 0;
    } catch (e) {
      if (++failures > 5) throw e;
      await pause(1000 * failures);
      const held = (await fetch(url, { method: "HEAD" })).headers.get("upload-offset");
      if (held !== null) offset = Number(held);
    }
    onProgress(offset);
  }
  return json<UploadResult>(await fetch(`${url}/finish`, { method: "POST" }));
}
