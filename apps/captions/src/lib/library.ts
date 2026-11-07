import type { AssetDetail, AssetPage, Collection, LibrarySettings, LibrarySummary, SearchHit, SearchQuery, ShareCreated, ShareInput } from "@contracts/library";

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

/** The owner's switches for a library: AI descriptions, search by meaning. */
export const updateLibrary = (libraryId: string, patch: { name?: string; settings?: Partial<LibrarySettings> }) =>
  send<LibrarySummary>(`/api/library/${libraryId}`, "PATCH", patch);

/** Title, tags (the whole list) or the human description ("" removes it, the AI's shows again). */
export const updateAsset = (libraryId: string, assetId: string, patch: { title?: string; tags?: string[]; description?: string }) =>
  send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}`, "PATCH", patch);

export function listAssets(libraryId: string, q: SearchQuery & { cursor?: string }): Promise<AssetPage> {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.kind?.length) p.set("kind", q.kind.join(","));
  if (q.collectionId) p.set("collectionId", q.collectionId);
  if (q.trashed) p.set("trashed", "1");
  if (q.cursor) p.set("cursor", q.cursor);
  return fetch(`/api/library/${libraryId}/assets?${p}`).then((r) => json<AssetPage>(r));
}

const send = <T,>(url: string, method: string, body?: unknown): Promise<T> =>
  fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => json<T>(r));

export const listCollections = (libraryId: string) =>
  send<{ collections: Collection[] }>(`/api/library/${libraryId}/collections`, "GET").then((x) => x.collections);

export const createCollection = (libraryId: string, input: { name: string; kind?: "manual" | "smart"; query?: SearchQuery; parentId?: string }) =>
  send<Collection>(`/api/library/${libraryId}/collections`, "POST", input);

export const changeFolderItems = (libraryId: string, collectionId: string, assetIds: string[], add: boolean) =>
  send<unknown>(`/api/library/${libraryId}/collections/${collectionId}/items`, add ? "POST" : "DELETE", { assetIds });

/** Into the trash (`trash` true) or back out of it. */
export const setTrashed = (libraryId: string, assetId: string, trash: boolean) =>
  send<unknown>(`/api/library/${libraryId}/assets/${assetId}${trash ? "" : "/restore"}`, trash ? "DELETE" : "POST");

/** Titles, tags and what is said in the clips: a hit with `seconds` is a line said at that second. */
export const searchLibrary = (libraryId: string, q: string) =>
  send<SearchHit[]>(`/api/library/${libraryId}/search?${new URLSearchParams({ q })}`, "GET");

export const getAsset = (libraryId: string, assetId: string) => send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}`, "GET");

/** Queue a job again (a transcript that needed a key), as the caller. */
export const rerunJobs = (libraryId: string, assetId: string, kinds: string[]) =>
  send<unknown>(`/api/library/${libraryId}/assets/${assetId}/jobs`, "POST", { kinds });

/** A Caption Studio project on the clip; resolves once its editing proxy is ready. */
export const openInCaptions = (libraryId: string, assetId: string) =>
  send<{ projectId: string }>(`/api/library/${libraryId}/assets/${assetId}/captions`, "POST");

export const createShare = (libraryId: string, input: ShareInput) => send<ShareCreated>(`/api/library/${libraryId}/shares`, "POST", input);

export interface UploadResult {
  assetId?: string;
  duplicateOf?: string;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * One file into the library: create the upload, then PATCH chunks from the offset the server reports. A 409 gives the
 * offset to resume from; a dropped request asks HEAD where the server stopped. Five failures in a row give up.
 * With `collectionId` (a manual folder) the server puts the new asset in that folder when it finishes.
 */
export async function uploadFile(libraryId: string, file: File, onProgress: (sent: number) => void, collectionId?: string): Promise<UploadResult> {
  const init = await fetch(`/api/library/${libraryId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.name, size: file.size, collectionId }),
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
