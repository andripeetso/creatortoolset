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
}

export interface SearchQuery {
  q?: string;
  kind?: AssetKind[];
  collectionId?: string;
  tag?: string;
  from?: number;
  to?: number;
  hasTranscript?: boolean;
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

/** A library the caller can see, with whether they manage it (the workspace owner). */
export interface LibrarySummary {
  id: string;
  name: string;
  storage: "local" | "s3" | "bunny";
  canManage: boolean;
}

export interface AssetPage {
  items: AssetCard[];
  next?: string; // cursor for the next page
}
