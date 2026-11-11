import type {
  AssetCard,
  AssetDetail,
  AssetPage,
  Collection,
  LibraryEstimate,
  LibraryProgress,
  LibrarySettings,
  LibraryStorage,
  LibraryStorageInput,
  LibrarySummary,
  Piece,
  SearchHit,
  SearchQuery,
  ShareCreated,
  ShareInput,
} from "@contracts/library";
import { useEffect, useRef } from "react";
import { putDirect } from "@/lib/uploads";
import { boot, onTopic, seqNow, whenVisible } from "@/lib/sync";

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

/** What is going in: `clips` files of `bytes`, `audio` of them sound only (`audioBytes`), from a music folder or not. */
export interface Drop {
  clips: number;
  bytes: number;
  audio?: number;
  audioBytes?: number;
  music?: boolean;
}

/** Sound-only files among `files`, and their bytes (the server's own kinds, api/library/routes.ts kindOf). */
export const audioOf = (files: File[]) => {
  const audio = files.filter((f) => /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(f.name));
  return { audio: audio.length, audioBytes: audio.reduce((n, f) => n + f.size, 0) };
};

/** What processing a drop would take in the library (api/library/estimate.ts). */
export const getEstimate = (libraryId: string, d: Drop) =>
  fetch(
    `/api/library/${libraryId}/estimate?clips=${d.clips}&bytes=${Math.round(d.bytes)}&audio=${d.audio ?? 0}&audioBytes=${Math.round(d.audioBytes ?? 0)}${d.music ? "&music=1" : ""}`,
  ).then((r) => json<LibraryEstimate>(r));

/** The processing still to do in the library. */
export const getProgress = (libraryId: string) => fetch(`/api/library/${libraryId}/progress`).then((r) => json<LibraryProgress>(r));

export const createLibrary = (name: string) =>
  fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then(
    (r) => json<LibrarySummary>(r),
  );

/** The owner's switches for a library: AI descriptions, search by meaning. */
export const updateLibrary = (libraryId: string, patch: { name?: string; settings?: Partial<LibrarySettings> }) =>
  send<LibrarySummary>(`/api/library/${libraryId}`, "PATCH", patch);

/** Where the library's files live and how much its bucket holds (the owner only). */
export const getLibraryStorage = (libraryId: string) => send<LibraryStorage>(`/api/library/${libraryId}/usage`, "GET");

export const setLibraryStorage = (libraryId: string, input: LibraryStorageInput) => send<LibraryStorage>(`/api/library/${libraryId}/storage`, "PUT", input);

/** Title, tags (the whole list) or the human description ("" removes it, the AI's shows again). */
export const updateAsset = (libraryId: string, assetId: string, patch: { title?: string; tags?: string[]; description?: string }) =>
  send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}`, "PATCH", patch);

export function listAssets(libraryId: string, q: SearchQuery & { cursor?: string; source?: string }): Promise<AssetPage> {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.kind?.length) p.set("kind", q.kind.join(","));
  if (q.collectionId) p.set("collectionId", q.collectionId);
  if (q.limit) p.set("limit", String(q.limit));
  if (q.trashed) p.set("trashed", "1");
  if (q.cursor) p.set("cursor", q.cursor);
  // a plug-in source's cards instead of the library's (the Sources group in the sidebar)
  if (q.source) p.set("source", q.source);
  setFacets(p, q.facets);
  return fetch(`/api/library/${libraryId}/assets?${p}`).then((r) => json<AssetPage>(r));
}

/** The plug-in sources this account may browse in the library (the built-in library is not one of them). */
export function listSources(libraryId: string): Promise<{ id: string; label: string }[]> {
  return fetch(`/api/library/${libraryId}/sources`)
    .then((r) => json<{ sources: { id: string; label: string }[] }>(r))
    .then((d) => d.sources);
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
export const searchLibrary = (libraryId: string, q: string, facets?: Record<string, string[]>) => {
  const p = new URLSearchParams({ q });
  setFacets(p, facets);
  return send<SearchHit[]>(`/api/library/${libraryId}/search?${p}`, "GET");
};

/** Plug-in facet picks as `f.<key>=a,b` (api/library/query.ts reads them back). */
function setFacets(p: URLSearchParams, facets: Record<string, string[]> | undefined) {
  for (const [key, values] of Object.entries(facets ?? {})) if (values.length) p.set(`f.${key}`, values.join(","));
}

export const getAsset = (libraryId: string, assetId: string) => send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}`, "GET");

/** Queue a job again (a transcript that needed a key), as the caller. */
export const rerunJobs = (libraryId: string, assetId: string, kinds: string[]) =>
  send<unknown>(`/api/library/${libraryId}/assets/${assetId}/jobs`, "POST", { kinds });

/** A Caption Studio project on the clip; resolves once its editing proxy is ready. */
export const openInCaptions = (libraryId: string, assetId: string) =>
  send<{ projectId: string }>(`/api/library/${libraryId}/assets/${assetId}/captions`, "POST");

export const createShare = (libraryId: string, input: ShareInput) => send<ShareCreated>(`/api/library/${libraryId}/shares`, "POST", input);

/** Finals: the plain manual collection named Finals at the top of a library (the Media Library makes it on first use). */
export const FINALS = "Finals";
export const isFinals = (c: Collection) => c.kind === "manual" && c.parentId === null && c.name === FINALS;

/** A Finals piece linked to a Content Workshop session (keyed by piece id): its status ("toPost" = Ready to post), the
 *  piece's post description, and each version's own description (keyed by the piece item id). */
export interface WorkshopFinal {
  description: string;
  versions: Record<string, { text: string; label?: string; author: "ai" | "user" }>;
  sessionId: string;
  status?: string;
}
export const getWorkshopFinals = () => send<{ pieces: Record<string, WorkshopFinal> }>("/api/library/workshop", "GET").then((r) => r.pieces);

/** The pieces of one collection (Finals is one): versions grouped with a winner, postings and a post description. */
export const listPieces = (libraryId: string, collectionId: string) =>
  send<{ pieces: Piece[] }>(`/api/library/${libraryId}/pieces?collectionId=${encodeURIComponent(collectionId)}`, "GET").then((x) => x.pieces);

/**
 * Every card the viewer may see in a library, with the facet picks applied, read page by page. Finals needs whole
 * libraries here because a piece's versions can sit anywhere in it.
 * ponytail: reads the whole library on each change of a facet; a per-version lookup when libraries get big.
 */
export async function listAllAssets(libraryId: string, facets?: Record<string, string[]>): Promise<AssetCard[]> {
  const out: AssetCard[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAssets(libraryId, { facets, limit: 200, cursor });
    out.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return out;
}

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
  }).then((r) => json<{ id: string; offset: number; chunkSize: number; direct?: { partSize: number; urls: string[] } }>(r));
  const url = `/api/library/uploads/${init.id}`;
  if (init.direct) {
    // a bucket library: the parts go straight to the bucket, then the server joins them from their ETags
    const parts = await putDirect(file, init.direct, onProgress);
    return json<UploadResult>(
      await fetch(`${url}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }) }),
    );
  }
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

/*
 * Piece writes (api/library/collections.ts). Each one answers with the piece as the server now holds it, so the caller
 * replaces its copy and never guesses the order, the single winner or the dropped items.
 */
const pieceUrl = (libraryId: string, pieceId: string) => `/api/library/${libraryId}/pieces/${pieceId}`;
const itemUrl = (libraryId: string, pieceId: string, itemId: string) => `${pieceUrl(libraryId, pieceId)}/items/${itemId}`;
/** Save all: the piece's visible versions as one ZIP, in drag order (a download link, not a call). */
export const pieceZipUrl = (libraryId: string, pieceId: string) => `${pieceUrl(libraryId, pieceId)}/zip`;

export const renamePiece = (libraryId: string, pieceId: string, label: string) => send<Piece>(pieceUrl(libraryId, pieceId), "PATCH", { label });

export const deletePiece = (libraryId: string, pieceId: string) => send<{ ok: true }>(pieceUrl(libraryId, pieceId), "DELETE");

/** One piece, with the items the viewer may see and `writable`. Rejects (404) when the account sees none of it. */
export const getPiece = (libraryId: string, pieceId: string) => send<Piece>(pieceUrl(libraryId, pieceId), "GET");

/** A frame at `t` seconds of one of the piece's versions (a still is its own picture) becomes the cover. */
export const setPieceCover = (libraryId: string, pieceId: string, versionId: string, t: number) =>
  send<Piece>(`${pieceUrl(libraryId, pieceId)}/cover`, "POST", { versionId, t });

/** Back to the automatic cover: the winner's frame. */
export const clearPieceCover = (libraryId: string, pieceId: string) => send<Piece>(`${pieceUrl(libraryId, pieceId)}/cover`, "DELETE");

/** A version of this library (not trashed) becomes the piece's last item. */
export const addPieceItem = (libraryId: string, pieceId: string, versionId: string) =>
  send<Piece>(`${pieceUrl(libraryId, pieceId)}/items`, "POST", { versionId });

/** The item's label, its position, the winner flag (setting it clears the old winner) and its post description ("" removes it). */
export const patchPieceItem = (
  libraryId: string,
  pieceId: string,
  itemId: string,
  patch: { label?: string | null; position?: number; winner?: boolean; postDescription?: string },
) => send<Piece>(itemUrl(libraryId, pieceId, itemId), "PATCH", patch);

/** The piece's trashed Finals pieces of one collection (the trash view). */
export const listTrashedPieces = (libraryId: string, collectionId: string) =>
  send<{ pieces: Piece[] }>(`/api/library/${libraryId}/pieces?collectionId=${encodeURIComponent(collectionId)}&trash=1`, "GET").then((x) => x.pieces);

/** Into the Finals trash (listed for 5 days, then gone for good) and back out. Its versions stay in the library. */
export const trashPiece = (libraryId: string, pieceId: string) => send<Piece>(`${pieceUrl(libraryId, pieceId)}/trash`, "POST");
export const restorePiece = (libraryId: string, pieceId: string) => send<Piece>(`${pieceUrl(libraryId, pieceId)}/restore`, "POST");

/** Joins the piece `fromId` into this one: its versions move over, this piece keeps its name, winner and cover. 409 when both hold a version. */
export const mergePiece = (libraryId: string, pieceId: string, fromId: string) => send<Piece>(`${pieceUrl(libraryId, pieceId)}/merge`, "POST", { from: fromId });

/** The item leaves for a piece of its own (postings go with it); resolves to that new piece. */
export const splitPieceItem = (libraryId: string, pieceId: string, itemId: string) => send<Piece>(`${itemUrl(libraryId, pieceId, itemId)}/split`, "POST");

/** Links this Finals piece to a Workshop session: its versions get a post description per version there. */
export const linkPieceToSession = (sessionId: string, pieceId: string, docId?: string) =>
  send<{ linked: true }>(`/api/workshop/sessions/${sessionId}/finals`, "POST", docId ? { pieceId, docId } : { pieceId });

/** Takes the version out of the piece; the version itself stays in the library. */
export const removePieceItem = (libraryId: string, pieceId: string, itemId: string) => send<Piece>(itemUrl(libraryId, pieceId, itemId), "DELETE");

export const addPosting = (libraryId: string, pieceId: string, itemId: string, input: { platform: string; url?: string }) =>
  send<Piece>(`${itemUrl(libraryId, pieceId, itemId)}/postings`, "POST", input);

export const removePosting = (libraryId: string, pieceId: string, itemId: string, postingId: number) =>
  send<Piece>(`${itemUrl(libraryId, pieceId, itemId)}/postings/${postingId}`, "DELETE");

/**
 * The position changes for a drag from index `from` to index `to` in a piece's items (already in display order).
 * Positions become 1..n in the new order; only the items whose position changed come back, one PATCH each.
 */
export function reorderedPositions(items: { id: string; position: number }[], from: number, to: number): { id: string; position: number }[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [];
  const order = [...items];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order.flatMap((it, i) => (it.position === i + 1 ? [] : [{ id: it.id, position: i + 1 }]));
}

let watchers = 0;
/** Whether a "library" notice is news to a page that last saw `was`: the tab's first hello only says where the stream
 *  starts (the page has just read its list); a newer change or a restarted server is news. */
export const libraryNews = (was: { seq: number; boot: string }, n: number, bootNow: string) =>
  !!was.boot && (n > was.seq || bootNow !== was.boot);

/**
 * Calls `onChange` when this account's Media Library or Finals changed: in another tab, on another device, or in the
 * server's own work (a picture made, a watch folder's file). The change stream's "library" topic (lib/sync.ts): a burst
 * is one call 300 ms later, a hidden window waits until it is shown, and this tab's own writes are skipped.
 */
export function useLibraryChanges(onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const key = `library-changes:${++watchers}`;
    let seen = { seq: seqNow(), boot: boot() };
    return onTopic("library", (n) => {
      const was = seen;
      seen = { seq: boot() === was.boot ? Math.max(n, was.seq) : n, boot: boot() };
      if (libraryNews(was, n, boot())) whenVisible(key, () => latest.current());
    });
  }, []);
}
