import { hostsOriginals, hostsProxies, uploadSent } from "@contracts/library";
import type {
  LibraryMade,
  MadeKind,
  Blur,
  TagCount,
  AssetKind,
  AssetCard,
  AssetDetail,
  AssetPage,
  Collection,
  LibraryEstimate,
  LibraryProgress,
  LibraryStatus,
  LibrarySpace,
  LibrarySettings,
  LibraryStorage,
  LibraryStorageInput,
  LibrarySummary,
  LibraryUpload,
  Piece,
  SearchHit,
  SearchQuery,
  ShareCreated,
  ShareInput,
  WatchStatus,
  WhereAnswer,
} from "@contracts/library";
import type { MovesAnswer, PlacesAnswer, PlacesReport, PlacesReportAnswer } from "@contracts/places";
import { useEffect, useRef } from "react";
import { putDirect } from "@/lib/uploads";
import { boot, onTopic, seqNow, whenVisible } from "@/lib/sync";
import { macMediaUrl, macPageMarked, pathOnMac } from "@/lib/thisMac";
import { addFromMac, deviceHere, indexOnMac, quickPrint } from "@/lib/onMac";
import { thisMacDevice } from "@/lib/providers";
import { bodyOf } from "@/lib/body";

/** The Media Library's calls to api/library/routes.ts, and the chunked upload that follows its offset protocol. */

/** The body, or the server's error with its `code` ("too_large": a refusal that a retry cannot change). */
async function json<T>(r: Response): Promise<T> {
  const body = (await bodyOf(r)) as T & { error?: string; code?: string };
  if (!r.ok) throw Object.assign(new Error(body.error ?? `Request failed (${r.status})`), { code: body.code });
  return body;
}

export const listLibraries = () =>
  fetch("/api/library")
    .then((r) => json<{ libraries: LibrarySummary[] }>(r))
    .then((x) => x.libraries);

/**
 * The Mac app on a server elsewhere, and the library's Upload is none: a file dropped or picked here is indexed where it is,
 * never sent to the server (local-first R-A1). The Mac app's bridge is the marker; a browser is never this case.
 */
export async function macIndexOnly(libraryId: string): Promise<boolean> {
  if (!macPageMarked()) return false;
  const libs = await listLibraries().catch(() => [] as LibrarySummary[]);
  // a library the list does not have (or none, when it fails) is not index-in-place: the upload goes as before
  const lib = libs.find((l) => l.id === libraryId);
  return !!lib && !hostsOriginals(uploadSent(lib.settings)) && !hostsProxies(uploadSent(lib.settings));
}

/** A member's add (drop or pick) with Hosted media Off has nowhere to go: refused in the Library page (SCREENS-COPY §3). */
export const addRefused = (l: LibrarySummary | null | undefined): boolean =>
  !!l?.readOnly && !hostsOriginals(uploadSent(l.settings)) && !hostsProxies(uploadSent(l.settings));

/**
 * A new workspace's upload choice (its form, components/workspace/ProjectList.tsx): kept on that workspace's own library,
 * made the way the Media Library page makes one when the workspace has none yet.
 */
export async function setWorkspaceUpload(workspaceId: string, settings: { upload: LibraryUpload; finalsUpload: LibraryUpload }): Promise<void> {
  const headers = { "content-type": "application/json", "X-CT-Workspace": workspaceId };
  const own = (await fetch("/api/library", { headers }).then((r) => json<{ libraries: LibrarySummary[] }>(r))).libraries.find((l) => !l.readOnly);
  const library: LibrarySummary = own ?? (await fetch("/api/library", { method: "POST", headers, body: JSON.stringify({ name: "Library" }) }).then((r) => json<LibrarySummary>(r)));
  await fetch(`/api/library/${library.id}`, { method: "PATCH", headers, body: JSON.stringify({ settings }) }).then((r) => json<LibrarySummary>(r));
}

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
export const getStatus = (libraryId: string) => fetch(`/api/library/${libraryId}/status`).then((r) => json<LibraryStatus>(r));
export const getProgress = (libraryId: string) => fetch(`/api/library/${libraryId}/progress`).then((r) => json<LibraryProgress>(r));

export const createLibrary = (name: string) =>
  fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then(
    (r) => json<LibrarySummary>(r),
  );

/** Each kind the library makes, with how many of its files have it and lack it (api/library/made.ts). */
export const getMade = (libraryId: string) => send<LibraryMade[]>(`/api/library/${libraryId}/made`, "GET");
/** Make for the missing: `kind` for every file of the library that lacks it. */
export const makeMissing = (libraryId: string, kind: MadeKind) => send<{ files: number }>(`/api/library/${libraryId}/made/${kind}`, "POST");
/** Cancel: `kind`'s queued work taken off the queue. */
export const stopMade = (libraryId: string, kind: MadeKind) => send<{ files: number }>(`/api/library/${libraryId}/made/${kind}/stop`, "POST");
/** Stop: every kind's queued work taken off the queue. */
export const stopLibrary = (libraryId: string) => send<{ files: number }>(`/api/library/${libraryId}/stop`, "POST");
/** A step's failed jobs queued again. */
export const retryFailed = (libraryId: string, kind: string) => send<{ files: number }>(`/api/library/${libraryId}/retry/${kind}`, "POST");

/** The owner's switches for a library: AI descriptions, shot descriptions, search by meaning. */
export const updateLibrary = (libraryId: string, patch: { name?: string; settings?: Partial<LibrarySettings> }) =>
  send<LibrarySummary>(`/api/library/${libraryId}`, "PATCH", patch);

/** Where the library's files live and how much its bucket holds (the owner only). */
export const getLibraryStorage = (libraryId: string) => send<LibraryStorage>(`/api/library/${libraryId}/usage`, "GET");

/** What the library's own made files take (the owner only), and clearing the ones it makes again. */
export const getLibrarySpace = (libraryId: string) => send<LibrarySpace>(`/api/library/${libraryId}/space`, "GET");
export const clearLibrarySpace = (libraryId: string, what: "proxies" | "models") =>
  send<{ cleared: number; kept: number }>(`/api/library/${libraryId}/space/clear`, "POST", { what });

export const setLibraryStorage = (libraryId: string, input: LibraryStorageInput) => send<LibraryStorage>(`/api/library/${libraryId}/storage`, "PUT", input);

/** Title, tags (the whole list) or the human description ("" removes it, the AI's shows again). */
export const updateAsset = (libraryId: string, assetId: string, patch: { title?: string; tags?: string[]; aiTags?: string[]; description?: string; turn?: number }) =>
  send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}`, "PATCH", patch);

/** A file's blur answer changed later (contracts Blur): yes queues its blur; no only for the owner or an admin. */
export const setAssetBlur = (libraryId: string, assetId: string, blur: Blur) => send<{ blur: Blur }>(`/api/library/${libraryId}/assets/${assetId}/blur`, "PUT", { blur });

/** The person's own line for one shot of a clip (empty: the AI's shows again). */
export const updateShot = (libraryId: string, assetId: string, seg: number, text: string) =>
  send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}/shots/${seg}`, "PATCH", { text });

export function listAssets(libraryId: string, q: SearchQuery & { cursor?: string; source?: string }): Promise<AssetPage> {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.kind?.length) p.set("kind", q.kind.join(","));
  if (q.collectionId) p.set("collectionId", q.collectionId);
  if (q.limit) p.set("limit", String(q.limit));
  if (q.trashed) p.set("trashed", "1");
  if (q.unfiled) p.set("unfiled", "1");
  if (q.roll) p.set("roll", q.roll);
  // an empty list sends a version id no clip has, so the answer is empty (an empty `versions` would mean every clip)
  if (q.versions) p.set("versions", q.versions.length ? q.versions.join(",") : "none");
  if (q.cursor) p.set("cursor", q.cursor);
  if (q.sort) p.set("sort", q.sort);
  // a plug-in source's cards instead of the library's (the Sources group in the sidebar)
  if (q.source) p.set("source", q.source);
  setFacets(p, q.facets);
  setFilters(p, q);
  return fetch(`/api/library/${libraryId}/assets?${p}`).then((r) => json<AssetPage>(r));
}

/** Every tag in the library with how many clips carry it, most used first. */
export function listTags(libraryId: string): Promise<TagCount[]> {
  return fetch(`/api/library/${libraryId}/tags`)
    .then((r) => json<{ tags: TagCount[] }>(r))
    .then((d) => d.tags);
}

/** The countries the library's clips were filmed in (ISO 3166-1 alpha-2) with how many each, most first. */
export function listPlaces(libraryId: string): Promise<{ place: string; count: number }[]> {
  return fetch(`/api/library/${libraryId}/countries`)
    .then((r) => json<{ places: { place: string; count: number }[] }>(r))
    .then((d) => d.places);
}

/** Up to 8 clips close in meaning to this one (api/library/related.ts); none without vectors. */
export const relatedAssets = (libraryId: string, assetId: string) =>
  fetch(`/api/library/${libraryId}/assets/${assetId}/related`)
    .then((r) => json<{ related: AssetCard[] }>(r))
    .then((d) => d.related);

/** More like this: the shots that look most like this clip's shot at `at` seconds, or like the clip (api/library/related.ts); none without picture vectors. */
export const alikeShots = (libraryId: string, assetId: string, at?: number) =>
  fetch(`/api/library/${libraryId}/assets/${assetId}/alike${at === undefined ? "" : `?at=${at}`}`)
    .then((r) => json<{ hits: SearchHit[] }>(r))
    .then((d) => d.hits);

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

export const createCollection = (libraryId: string, input: { name: string; kind?: "manual" | "smart"; query?: SearchQuery; parentId?: string; rule?: string }) =>
  send<Collection>(`/api/library/${libraryId}/collections`, "POST", input);

export const changeFolderItems = (libraryId: string, collectionId: string, assetIds: string[], add: boolean) =>
  send<{ added?: number; removed?: number }>(`/api/library/${libraryId}/collections/${collectionId}/items`, add ? "POST" : "DELETE", { assetIds });

export const renameCollection = (libraryId: string, collectionId: string, name: string) =>
  send<Collection>(`/api/library/${libraryId}/collections/${collectionId}`, "PATCH", { name });
/** A folder into another (null: the top); the server refuses one inside itself */
export const moveCollection = (libraryId: string, collectionId: string, parentId: string | null) =>
  send<Collection>(`/api/library/${libraryId}/collections/${collectionId}`, "PATCH", { parentId });
/** Blur faces off for a folder ("no": its clips are kept as filmed), or on again (null: they follow the library) */
export const folderBlur = (libraryId: string, collectionId: string, blur: "no" | null) =>
  send<Collection>(`/api/library/${libraryId}/collections/${collectionId}`, "PATCH", { blur });

/** The folders in this order (the tabs dragged into place); the server keeps it for everyone who opens the library */
export const orderCollections = (libraryId: string, ids: string[]) => send<{ ok: true }>(`/api/library/${libraryId}/collections/order`, "PUT", { ids });

/** The folder goes (api/library/collections.ts): its folders move up one level, its clips stay in the library. */
export const deleteCollection = (libraryId: string, collectionId: string) =>
  send<{ ok: true }>(`/api/library/${libraryId}/collections/${collectionId}`, "DELETE");

/** Into the trash (`trash` true) or back out of it. */
export const setTrashed = (libraryId: string, assetId: string, trash: boolean) =>
  send<unknown>(`/api/library/${libraryId}/assets/${assetId}${trash ? "" : "/restore"}`, trash ? "DELETE" : "POST");
/** Empty trash (the owner): everything in the library's trash is deleted for good. */
export const emptyTrash = (libraryId: string) => send<{ deleted: number }>(`/api/library/${libraryId}/trash/empty`, "POST");

/**
 * Titles, tags, descriptions, what is said in the clips and, when it is on, what they mean, best first: a hit with
 * `seconds` is a line said at that second. `meaningGettingReady`: search by meaning is not ready yet (its model is
 * fetched the first time), so these hits are by words. `picturesPending`: the search's English line for matching
 * pictures is being written, so asked again soon it finds them too.
 */
export const searchLibrary = async (
  libraryId: string,
  q: string,
  narrow: { facets?: Record<string, string[]>; kind?: AssetKind; collectionId?: string; roll?: "a" | "b" } & LibraryFilters = {},
): Promise<{ hits: SearchHit[]; meaningGettingReady: boolean; picturesPending?: boolean }> => {
  const p = new URLSearchParams({ q });
  if (narrow.kind) p.set("kind", narrow.kind);
  if (narrow.collectionId) p.set("collectionId", narrow.collectionId);
  if (narrow.roll) p.set("roll", narrow.roll);
  setFacets(p, narrow.facets);
  setFilters(p, narrow);
  const r = await fetch(`/api/library/${libraryId}/search?${p}`);
  return {
    hits: await json<SearchHit[]>(r),
    meaningGettingReady: r.headers.get("x-search-meaning") === "getting-ready",
    ...(r.headers.get("x-search-pictures") === "pending" ? { picturesPending: true } : {}),
  };
};

/** The library's own filters (src/pages/library/Filters.tsx): tags, when it was filmed, where, on this computer. */
/** Available offline (M14) is the person's own list of clips, sent as `versions`: never saved with a search. */
export type LibraryFilters = Pick<SearchQuery, "tags" | "filmedFrom" | "filmedTo" | "place" | "orientation" | "here" | "missing"> & { offline?: true };

/**
 * Those filters as query parameters (api/library/query.ts parseSearch reads them back). In the Mac app the page also
 * names its own computer, so cards on it are marked and On this computer can narrow to them.
 */
function setFilters(p: URLSearchParams, f: LibraryFilters) {
  const device = thisMacDevice();
  if (device) p.set("device", device);
  if (device && f.here) p.set("here", "1");
  if (device && f.missing) p.set("missing", "1");
  if (f.tags?.length) p.set("tag", f.tags.join(","));
  if (f.filmedFrom !== undefined) p.set("filmedFrom", String(f.filmedFrom));
  if (f.filmedTo !== undefined) p.set("filmedTo", String(f.filmedTo));
  if (f.place) p.set("place", f.place);
  if (f.orientation) p.set("orientation", f.orientation);
}

/** Plug-in facet picks as `f.<key>=a,b` (api/library/query.ts reads them back). */
function setFacets(p: URLSearchParams, facets: Record<string, string[]> | undefined) {
  for (const [key, values] of Object.entries(facets ?? {})) if (values.length) p.set(`f.${key}`, values.join(","));
}

/** Where each version's original is, seen from this Mac (in a browser: any of the person's computers): the place words. */
export function getWhere(libraryId: string, versions: string[]): Promise<WhereAnswer> {
  const device = thisMacDevice();
  return send<WhereAnswer>(`/api/library/${libraryId}/where?versions=${versions.map(encodeURIComponent).join(",")}${device ? `&device=${encodeURIComponent(device)}` : ""}`, "GET");
}

/** One clip, seen from this Mac: with its id the server gives the path of this Mac's own copy (Show in Finder, Copy path). */
export function getAsset(libraryId: string, assetId: string) {
  const device = thisMacDevice();
  return send<AssetDetail>(`/api/library/${libraryId}/assets/${assetId}${device ? `?device=${encodeURIComponent(device)}` : ""}`, "GET");
}

/** Queue a job again (a transcript that needed a key), as the caller. */
export const rerunJobs = (libraryId: string, assetId: string, kinds: string[]) =>
  send<unknown>(`/api/library/${libraryId}/assets/${assetId}/jobs`, "POST", { kinds });

/** The same on many clips (every clip without `assetIds`), as the caller (api/library/bulk.ts); `count`: only how many. */
export const redoMany = (libraryId: string, kinds: string[], assetIds?: string[], count?: boolean) =>
  send<{ clips: number }>(`/api/library/${libraryId}/jobs`, "POST", { kinds, assetIds, count });

/** Many clips' originals as one zip (api/library/bulk.ts). */
export const libraryZipUrl = (libraryId: string, assetIds: string[]) => `/api/library/${libraryId}/zip?ids=${assetIds.map(encodeURIComponent).join(",")}`;

/**
 * Before an upload: whether a clip of this size is here (`maybe`), or with its sha256 which clip it is (api/library/routes.ts);
 * with the quick fingerprint too, also a version of that size and fingerprint, and which version.
 */
export const checkUpload = (libraryId: string, size: number, sha256?: string, quick?: string) =>
  send<{ maybe?: boolean; duplicateOf?: string; versionId?: string }>(`/api/library/${libraryId}/uploads/check`, "POST", { size, sha256, quick });

/** The paths a computer of the caller's tries for each version (api/library/places.ts; at most PLACES_MAX). */
export const versionPlaces = (libraryId: string, device: string, versions: string[]) =>
  send<PlacesAnswer>(`/api/library/${libraryId}/places?${new URLSearchParams({ device, versions: versions.join(",") })}`, "GET");

/** What a computer of the caller's read: each confirmed file becomes its place (api/library/places.ts). */
export const reportPlaces = (libraryId: string, report: PlacesReport) => send<PlacesReportAnswer>(`/api/library/${libraryId}/places`, "POST", report);

/** The last files that moved or were found elsewhere, one line per folder change (api/library/places.ts). */
export const placeMoves = (libraryId: string) => send<MovesAnswer>(`/api/library/${libraryId}/places/moves`, "GET").then((r) => r.moves);

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
 * Every card of a view (the query's, from its `cursor` on), read page by page in the largest pages the server gives.
 * Finals needs whole libraries because a piece's versions can sit anywhere in it; the Media Library's Select all the
 * pages not scrolled to yet.
 * ponytail: Finals reads the whole library on each change of a facet; a per-version lookup when libraries get big.
 */
export async function listAllAssets(libraryId: string, q: SearchQuery & { cursor?: string; source?: string } = {}): Promise<AssetCard[]> {
  const out: AssetCard[] = [];
  let cursor = q.cursor;
  do {
    const page = await listAssets(libraryId, { ...q, limit: 200, cursor });
    out.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return out;
}

/** At most this many `versions` per asset-list request (contracts/library.ts SearchQuery). */
const VERSIONS_MAX = 200;

/**
 * The cards of these versions (a piece's, a list of pieces'). The library's list leaves finished clips out unless they
 * are named (api/library/query.ts), so Finals reads its versions by id, never the whole library.
 */
export async function cardsOfVersions(libraryId: string, versionIds: string[], q: SearchQuery = {}): Promise<AssetCard[]> {
  const ids = [...new Set(versionIds)];
  const chunks = Array.from({ length: Math.ceil(ids.length / VERSIONS_MAX) }, (_, n) => ids.slice(n * VERSIONS_MAX, (n + 1) * VERSIONS_MAX));
  return (await Promise.all(chunks.map((versions) => listAllAssets(libraryId, { ...q, versions })))).flat();
}

/** Every version id the pieces hold (an item from another source has none). */
export const pieceVersions = (pieces: Piece[]): string[] => pieces.flatMap((p) => p.items.flatMap((i) => (i.versionId ? [i.versionId] : [])));

export interface UploadResult {
  assetId?: string;
  duplicateOf?: string;
  /** already in the library, as a clip this account may not see (no id) */
  duplicate?: true;
}

/** The file's blur answer when the person chose one for this import (api/library/upload-gate.ts blurAtIntake); none: the library's. */
const blurAsked = (asFilmed?: boolean, askBlur?: boolean) => (asFilmed ? { blur: false } : askBlur ? { blur: true } : {});

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A file the Mac app knows the place of, added where it is (api/library/routes.ts in-place): asked again while the
 * server is still reading it. null when this server or library cannot take it in place: it is uploaded instead.
 */
async function addInPlace(libraryId: string, where: string, size: number, collectionId?: string, asFilmed = false, askBlur = false): Promise<UploadResult | null> {
  for (let again = false; ; again = true) {
    const r = await fetch(`/api/library/${libraryId}/in-place`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: where, size, collectionId, again, ...blurAsked(asFilmed, askBlur) }),
    });
    if (r.status === 202) continue;
    if (r.status === 400 || r.status === 403) return null;
    return json<UploadResult>(r);
  }
}

/**
 * A final from Add final (components/workshop/AddFinalDialog.tsx). Finals are served (local-first R2), so under the
 * library's Upload none too it reaches the server: this Mac sends it from `copied` (its copy in the project's folder on
 * this Mac) or these bytes go. Only the Finals setting none keeps it on this Mac, read where it was copied.
 */
export async function uploadFinal(
  libraryId: string,
  file: File,
  copied: string | null,
  finalsUpload: LibraryUpload,
  collectionId: string | undefined,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<{ assetId?: string; duplicateOf?: string }> {
  if (copied && finalsUpload === "none") {
    return addFromMac(libraryId, { url: macMediaUrl(copied), name: copied.split("/").pop() ?? file.name, size: file.size, quick: await quickPrint(file) }, copied, collectionId, "none");
  }
  return uploadFile(libraryId, file, onProgress, collectionId, copied ?? undefined, { signal });
}

/**
 * One file into the library. Picked in the Mac app on its own server: added where it is, no copy (`onProgress(0, true)`
 * says so). Otherwise uploaded: create the upload, then PATCH chunks from the offset the server reports. A 409 gives the
 * offset to resume from; a dropped request asks HEAD where the server stopped. Five failures in a row give up.
 * With `collectionId` (a manual folder) the server puts the new asset in that folder when it finishes.
 */
export async function uploadFile(
  libraryId: string,
  file: File,
  onProgress: (sent: number, inPlace?: boolean) => void,
  collectionId?: string,
  /** where the file is on this Mac, when the page knows it already (a Finder drop) */
  knownPath?: string,
  /**
   * `signal`: Cancel; the upload stops, what reached the server is deleted, and it never resumes by itself.
   * `onMac`: the Mac app with a server elsewhere and uploading off: the file is indexed where it is (lib/onMac.ts) and
   * no byte of it is sent; with no known path it is refused, never uploaded. `blur`: the library has Blur faces on;
   * `asFilmed`: the person unticked Blur faces for this import, the file's blur answer is no (contracts Blur).
   */
  opts: { signal?: AbortSignal; onMac?: boolean; blur?: boolean; asFilmed?: boolean; askBlur?: boolean } = {},
): Promise<UploadResult> {
  const { signal, onMac } = opts;
  const where = knownPath ?? (await pathOnMac(file));
  if (where) {
    onProgress(0, true);
    const kept = await addInPlace(libraryId, where, file.size, collectionId, opts.asFilmed, opts.askBlur);
    if (kept) return kept;
    if (onMac) return indexOnMac(libraryId, file, where, collectionId, signal, opts.blur && !opts.asFilmed, opts.asFilmed, opts.askBlur);
    onProgress(0, false);
  }
  if (onMac) throw new NotUploaded("Not added: where it is on this Mac is unknown. Drop it from Finder");
  signal?.throwIfAborted();
  // where it is on this Mac, and which Mac: with "proxies only" the server keeps that place and lets the original go
  const fromDevice = where ? await deviceHere() : undefined;
  // and this Mac may send it itself (send): it makes the proxy and the small files from the file where it is, and the
  // server takes them instead of the original, or with it when the library keeps originals. No bytes go from here then
  const quick = where && fromDevice ? await quickPrint(file) : undefined;
  const init = await fetch(`/api/library/${libraryId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      collectionId,
      modified: file.lastModified, // Date filmed's fallback when the file says nothing of when it was filmed
      ...(where ? { fromPath: where } : {}),
      ...(fromDevice ? { fromDevice } : {}),
      ...(quick ? { quick, send: true } : {}),
      ...blurAsked(opts.asFilmed, opts.askBlur),
    }),
    signal,
  }).then((r) => json<{ id: string; offset: number; chunkSize: number; direct?: { partSize: number; urls: string[] }; sent?: true; assetId?: string; duplicateOf?: string }>(r));
  if (init.sent || init.duplicateOf) {
    onProgress(file.size);
    return init.duplicateOf ? { duplicateOf: init.duplicateOf } : { assetId: init.assetId! };
  }
  const url = `/api/library/uploads/${init.id}`;
  // cancelled: the server drops what it has (DELETE), so nothing picks it up again
  const drop = () => void fetch(url, { method: "DELETE" }).catch(() => {});
  signal?.addEventListener("abort", drop, { once: true });
  try {
    if (init.direct) {
      // a bucket library: the parts go straight to the bucket, then the server joins them from their ETags
      const parts = await putDirect(file, init.direct, onProgress, signal);
      return json<UploadResult>(
        await fetch(`${url}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }), signal }),
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
          signal,
        });
        if (r.status === 409) offset = ((await r.json()) as { offset: number }).offset;
        else if (r.ok) offset = Number(r.headers.get("upload-offset"));
        else throw new Error("Could not upload the file");
        failures = 0;
      } catch (e) {
        if (signal?.aborted || ++failures > 5) throw e;
        await pause(1000 * failures);
        const held = (await fetch(url, { method: "HEAD", signal })).headers.get("upload-offset");
        if (held !== null) offset = Number(held);
      }
      onProgress(offset);
    }
    return json<UploadResult>(await fetch(`${url}/finish`, { method: "POST", signal }));
  } finally {
    signal?.removeEventListener("abort", drop);
  }
}

/** A file the Mac app would have had to upload while uploading is off: it is not added. */
export class NotUploaded extends Error {
  readonly code = "not_uploaded";
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

/** Adds a library version to the piece, last (POST …/pieces/:pid/items); the piece as the server holds it. */
export const addPieceItem = (libraryId: string, pieceId: string, versionId: string) => send<Piece>(`${pieceUrl(libraryId, pieceId)}/items`, "POST", { versionId });

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

/** The library's footage folders as its owner sees them (anyone else: an error, so no status). */
/** Look for new files on a server that reads this computer's folders itself (This Mac): how many came in, and how many still settle. */
export async function scanWatchNow(libraryId: string): Promise<{ added: number; settling: number }> {
  const r = await fetch(`/api/library/${libraryId}/watch/scan`, { method: "POST" });
  const body = (await bodyOf(r)) as { added?: number; settling?: number; error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return { added: body.added ?? 0, settling: body.settling ?? 0 };
}

export async function getWatch(libraryId: string): Promise<WatchStatus> {
  const r = await fetch(`/api/library/${libraryId}/watch`);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return (await r.json()) as WatchStatus;
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
