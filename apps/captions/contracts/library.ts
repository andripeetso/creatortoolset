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
  /** a Review video (same id): Review owns its versions and its trash, so the library opens it there */
  review?: true;
  /** while the clip is being prepared: the step it is on (running) or waits for next (LibraryProcessing.tsx ClipStage draws it) */
  preparing?: { step: LibraryStage["kind"] | "probe" | "wave"; running: boolean };
  /** a `failed` clip: the step that failed and the tool's own error (ClipStage says it in words) */
  failed?: { step: "probe" | "thumb" | "wave" | "proxy"; error: string };
}

export interface AssetDetail extends AssetCard {
  versions: { id: string; n: number; bytes: number; createdAt: number; createdBy: string; state: VersionState }[];
  transcript?: { provider: string; segments: { start: number; end: number; text: string }[] };
  collections: { id: string; name: string }[];
  sourcePath?: string; // reference-mode only, shown to owner/admin only
  /** the current version's background jobs: a transcribe that `needs_key` says why in `error`; one running on this computer says what it is doing there */
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
  /** plug-in sidebar filters: facet key → chosen values (api/library/sources.ts) */
  facets?: Record<string, string[]>;
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
  target: { kind: "asset" | "version" | "collection" | "piece"; id: string };
  scope: "view" | "download" | "comment";
  expiresInDays: number; // default 7, max 90
  password?: string;
}

/** What the owner switches on per library. Both spend AI on every upload, so both start off. */
export interface LibrarySettings {
  describe: boolean; // the AI writes a description and tags for each new video
  embed: boolean; // semantic search: search by meaning as well as by words
}

/** One of the caller's libraries. */
/** One step of a library's processing: the server's own work on the files, the transcript, the AI's description, search by meaning. */
export type LibraryStep = "files" | "transcript" | "describe" | "embed";

/**
 * What a step runs on for the asking account: their connected AI (`provider`, on its subscription), their own Anthropic
 * key (`api`), the team's budget (`budget`), a transcription key, this computer (`device`, free), the server (`server`);
 * `none`: nothing to run it on yet (`missing` says what to add); `off`: the library has the step switched off.
 */
export type LibraryStepRoute = "provider" | "api" | "budget" | "deepgram" | "openai" | "device" | "server" | "none" | "off";

export interface LibraryStepEstimate {
  step: LibraryStep;
  route: LibraryStepRoute;
  missing?: string;
  /** dollars for these clips; on `provider` what the API would have charged (the subscription pays, its limits count) */
  usd: number;
  seconds: number;
  /** pace and cost come from this server's own finished runs, not the starting guess */
  measured: boolean;
}

/** GET /api/library/:id/estimate?clips&bytes: what processing that many clips would take, before they go in. */
export interface LibraryEstimate {
  clips: number;
  /** of footage, from the bytes at this library's own bytes per second */
  minutes: number;
  steps: LibraryStepEstimate[];
  /** the whole run: the slowest step (steps run side by side) */
  seconds: number;
  /** describe on the person's own Anthropic key instead (it runs six at once; a connected AI runs two): when that is faster */
  withApiKey?: { seconds: number; usd: number };
}

/** One step of a library's preparing, as the person sees it go by: how many clips have it, of how many. */
export interface LibraryStage {
  /** thumb = pictures, proxy = lighter copies, fingerprint = duplicate checks, transcribe, describe, embed = search by meaning */
  kind: "thumb" | "proxy" | "fingerprint" | "transcribe" | "describe" | "embed";
  done: number;
  /** done, failed and still to do since this run of the queue began: neither number goes down while it runs */
  of: number;
  failed: number;
  /** the clip it is on right now */
  now?: string;
}

/** GET /api/library/:id/progress: the processing still to do in a library. Nothing to do = `left` 0. */
export interface LibraryProgress {
  /** jobs done and still to do since the queue was last empty */
  done: number;
  left: number;
  /** clips with work left */
  clips: number;
  /** time left at this server's pace */
  seconds: number;
  /** jobs waiting for a key or an AI, with what to add */
  waiting: { step: LibraryStep; count: number; missing: string; /** held back by the AI plan's usage limit */ limit?: boolean }[];
  /** each step's count, in the order they run; only the steps this run has */
  stages?: LibraryStage[];
}

export interface LibrarySummary {
  id: string;
  name: string;
  storage: "local" | "s3" | "bunny";
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
  kind: "local" | "s3" | "bunny";
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
  /** `files`: the media files the last look at the folder found; `adding`: how many of them are still to be taken in. */
  folders: (WatchFolder & { found: boolean; imported: number; files: number; adding: number })[];
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

/**
 * A piece: library versions grouped with one winner (the Finals list is the pieces of its collection). Items are
 * versions; `externalRef` is for items from another source (a catalog clip), set by the source, never by a request.
 */
export interface Piece {
  id: string;
  label: string;
  collectionId: string | null;
  createdBy: string;
  items: PieceItem[];
  /** The owner's picked frame (`?v=` stamped); absent or null = the automatic cover (the winner's thumbnail). */
  coverUrl?: string | null;
  /** Whether the viewer may change it: every item is theirs to change. Set on the single-piece read only. */
  writable?: boolean;
}

export interface PieceItem {
  id: string;
  label: string | null;
  position: number;
  winner: boolean; // at most one per piece
  versionId: string | null;
  externalRef: string | null; // exactly one of versionId and externalRef is set
  postDescription: string | null; // the text under a post, for this version
  postings: Posting[];
}

/** Where an item was posted (one version can be posted to several platforms, or several times). */
export interface Posting {
  id: number;
  platform: string;
  url: string | null;
  postedAt: number;
  createdBy: string;
}

/**
 * Own-bucket presets for the storage form: the endpoint, region and URL style each S3-compatible provider wants. A preset
 * whose endpoint is per account or per server (R2, MinIO) sets `endpoint` to "" and `endpointHint`, shown as the field's
 * placeholder: the owner types the real address (the server rejects `<…>` text in it). Path-style URLs work on all four,
 * and MinIO needs them.
 */
export const S3_PRESETS = [
  { id: "r2", name: "Cloudflare R2", endpoint: "", endpointHint: "https://<account-id>.r2.cloudflarestorage.com", region: "auto", pathStyle: true },
  { id: "b2", name: "Backblaze B2", endpoint: "https://s3.us-west-004.backblazeb2.com", endpointHint: "", region: "us-west-004", pathStyle: true },
  { id: "wasabi", name: "Wasabi", endpoint: "https://s3.us-east-1.wasabisys.com", endpointHint: "", region: "us-east-1", pathStyle: true },
  { id: "minio", name: "MinIO", endpoint: "", endpointHint: "https://your-minio-host:9000", region: "us-east-1", pathStyle: true },
] as const;

export type S3PresetId = (typeof S3_PRESETS)[number]["id"];

/**
 * The form with a preset's region and path-style set, and its endpoint when the preset has a fixed one (an empty preset
 * endpoint keeps what the field holds); the bucket and the keys are left as they are.
 */
export function applyS3Preset<T extends { endpoint: string; region: string; pathStyle: boolean }>(form: T, id: S3PresetId): T {
  const p = S3_PRESETS.find((x) => x.id === id);
  return p ? { ...form, endpoint: p.endpoint || form.endpoint, region: p.region, pathStyle: p.pathStyle } : form;
}
