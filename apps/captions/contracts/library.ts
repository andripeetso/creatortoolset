/**
 * Media Library: the types the web app and the server share (tasks/media-library-plan.md, section 7).
 * Routes live in api/library/routes.ts (later slices). Who may do what is in api/library/access.ts:
 * an owner of the workspace manages libraries; a member uploads, edits and shares their own assets.
 */

export type AssetKind = "video" | "image" | "audio" | "doc";
export type VersionState = "processing" | "ready" | "failed" | "missing";

export interface AssetCard {
  id: string;
  libraryId: string;
  kind: AssetKind;
  title: string;
  versionId: string;
  versionN: number;
  durationS?: number;
  width?: number;
  height?: number;
  thumbUrl?: string; // /api/library/media/<versionId>/thumb
  tags: string[]; // user and ai, with `aiTags` marking the AI ones
  aiTags: string[];
  description?: { text: string; source: "user" | "ai" };
  state: VersionState;
  capturedAt?: number;
  trashedAt?: number;
}

export interface AssetDetail extends AssetCard {
  versions: { id: string; n: number; bytes: number; createdAt: number; createdBy: string; state: VersionState }[];
  transcript?: { provider: string; segments: { start: number; end: number; text: string }[] };
  collections: { id: string; name: string }[];
  sourcePath?: string; // reference-mode only, shown to owner/admin only
  /** the current version's background jobs: a transcribe that `needs_key` says why in `error` */
  jobs: { kind: string; state: "queued" | "running" | "done" | "failed" | "needs_key"; error?: string }[];
}

export interface SearchQuery {
  q?: string;
  kind?: AssetKind[];
  collectionId?: string;
  tag?: string;
  from?: number;
  to?: number;
  hasTranscript?: boolean;
  trashed?: boolean; // the trash instead of the library
  cursor?: string;
  limit?: number; // limit ≤ 200
}

export interface SearchHit {
  asset: AssetCard;
  seconds?: number;
  snippet?: string;
}

export interface ShareInput {
  target: { kind: "asset" | "version" | "collection"; id: string };
  scope: "view" | "download" | "comment";
  expiresInDays: number; // default 7, max 90
  password?: string;
}

/** What the owner switches on per library. Both spend AI on every upload, so both start off. */
export interface LibrarySettings {
  describe: boolean; // the AI writes a description and tags for each new video
  embed: boolean; // semantic search: search by meaning as well as by words
}

/** A library the caller can see, with whether they manage it (the workspace owner). */
export interface LibrarySummary {
  id: string;
  name: string;
  storage: "local" | "s3";
  canManage: boolean;
  settings: LibrarySettings;
}

/**
 * Where a library's files live, as its owner sets it (PUT /api/library/:id/storage): the server's disk, the server's
 * bucket (set up by whoever runs the server), or the library's own S3-compatible bucket. Own keys may be left out to
 * keep the ones already saved; they are never sent back.
 */
export type LibraryStorageInput =
  | { kind: "local" }
  | { kind: "s3"; mode: "server" }
  | { kind: "s3"; mode: "own"; endpoint: string; region?: string; bucket: string; pathStyle?: boolean; accessKey?: string; secretKey?: string };

/** GET /api/library/:id/usage, the owner only. */
export interface LibraryStorage {
  kind: "local" | "s3";
  mode?: "server" | "own";
  endpoint?: string; // own bucket only
  region?: string;
  bucket?: string;
  pathStyle?: boolean;
  keysSet: boolean; // own bucket: its keys are saved (they never leave the server)
  serverBucket: boolean; // the server offers a bucket for libraries
  locked: boolean; // the library holds files: where they live can't change (the keys can)
  storedBytes?: number; // bucket libraries: bytes in the bucket now
  days: { day: string; storedBytes: number }[]; // bucket libraries: the last 30 days with a change, newest first
}

export interface AssetPage {
  items: AssetCard[];
  next?: string; // cursor for the next page
}

/** A folder or collection (manual: its items; smart: the saved SearchQuery, run on every read). */
export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
  kind: "manual" | "smart";
  query?: SearchQuery; // smart only
  count?: number; // manual only: items in it
  createdBy: string;
}

/** A share as its owner or creator lists it. `id` is the token's sha256, the handle for revoke: the token itself is shown once. */
export interface ShareRow {
  id: string;
  target: ShareInput["target"];
  scope: ShareInput["scope"];
  locked: boolean;
  createdBy: string;
  expiresAt: number;
  views: number;
}

export interface ShareCreated {
  id: string;
  token: string;
  url: string; // /library/s/<token>, in the web app
  expiresAt: number;
}

/** What a share link shows: one video (or a collection's videos), with media URLs on the share route. */
export interface SharedItem {
  id: string;
  title: string;
  kind: AssetKind;
  versionId: string;
  durationS?: number;
  width?: number;
  height?: number;
  thumbUrl?: string;
  playUrl: string;
  sourceUrl?: string; // scope download only
}

export interface SharedView {
  locked: boolean;
  name?: string; // not sent while locked
  scope?: ShareInput["scope"];
  items: SharedItem[];
}

/** A watch folder (api/library/watch.ts): a folder on the server's own disk whose new files join the library. */
export interface WatchFolder {
  path: string; // absolute, on the server's disk
  mode: "reference" | "copy"; // reference: the file stays where it is; copy: stored in the library like an upload
  collectionId?: string; // a manual folder the files go into
  addedBy: string; // the owner who added it; imports are theirs
}

/** GET /api/library/:id/watch. `allowed` is false on a hosted server: it cannot see the folders on your computer. */
export interface WatchStatus {
  allowed: boolean;
  folders: (WatchFolder & { found: boolean; imported: number })[];
  missing: number; // versions whose original is gone from its folder
}

/** A video that shares pictures with a clip (api/library/similar.ts): `overlap` is the share of the clip's seconds found in it. */
export interface SimilarMatch {
  assetId: string;
  libraryId: string;
  versionId: string;
  title: string;
  thumbUrl: string;
  overlap: number; // 0..1
}
