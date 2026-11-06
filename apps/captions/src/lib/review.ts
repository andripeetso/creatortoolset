import { chunkedUpload } from "@/lib/clips";

/** Review — Frame.io-style video review. Server: api/review.ts. */

export type Approval = "none" | "in_progress" | "needs_review" | "changes" | "approved";

export const APPROVAL: Record<Approval, { label: string; dot: string }> = {
  none: { label: "No status", dot: "bg-zinc-500" },
  in_progress: { label: "In progress", dot: "bg-sky-400" },
  needs_review: { label: "Needs review", dot: "bg-amber-400" },
  changes: { label: "Changes requested", dot: "bg-rose-500" },
  approved: { label: "Approved", dot: "bg-emerald-400" },
};

export interface ReviewVersion {
  n: number;
  name: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  status: "processing" | "ready" | "error";
  progress: number;
  error?: string;
  /** Captions are burned in (it skipped Caption Studio). */
  captioned?: boolean;
  /** The version in this stack without captions it was made from. */
  madeFrom?: number;
  bytes: number;
  /** Its video files were deleted to save space; comments and thumbnail stay. */
  removed?: boolean;
  createdAt: number;
}

export interface ReviewAsset {
  id: string;
  name: string;
  approval: { status: Approval; by?: string; at?: number };
  versions: ReviewVersion[];
  download: boolean;
  owner?: string;
  share?: ReviewShare | null;
  /** Owner only: the project (folder) it's in; null = top level. */
  projectId?: string | null;
  /** Owner only: marked Finished or In progress by hand. */
  done?: { finished: boolean; at: number } | null;
  createdAt: number;
  /** trash only */
  deletedAt?: number;
  /** list only */
  comments?: number;
  newComments?: number;
  updatedAt?: number;
}

/** Review's Finished tab: as marked by hand; a newer version reopens it. */
export const isFinished = (a: ReviewAsset) => {
  const d = a.done;
  return !!d && !a.versions.some((v) => v.createdAt > d.at) && d.finished;
};

/** A folder of Review videos. */
export interface ReviewProject {
  id: string;
  name: string;
  share?: ReviewShare | null;
  createdAt: number;
}

export type ReviewShare = { token: string; enabled: boolean; download: boolean };
export type SharePatch = { enabled?: boolean; download?: boolean; reset?: boolean };

/** One line in someone's inbox: "Ada commented on Launch cut". */
export interface ReviewNote {
  id: string;
  kind: "comment" | "reply" | "approved" | "changes" | "version" | "producing" | "delivered" | "workshop" | "failed";
  by: string;
  assetId: string;
  name: string;
  text?: string;
  href: string;
  at: number;
  read?: boolean;
}

export type Stroke = { color: string; points: [number, number][] };

export interface ReviewComment {
  id: string;
  version: number;
  parentId?: string;
  t?: number;
  tEnd?: number;
  text: string;
  author: string;
  user?: string;
  drawing?: Stroke[];
  /** Images and videos attached to show what's meant; an AI reads them too. */
  refs?: ReviewRef[];
  resolved?: boolean;
  createdAt: number;
  editedAt?: number;
  mine: boolean;
}

/** A reference on a comment; `video` = anything that moves, a GIF too. */
export type ReviewRef = { id: string; name: string; mime: string; bytes: number; kind: "image" | "video" };
/** boot.ts's body cap: one request, no chunking. */
const MAX_REF_BYTES = 50 * 1024 * 1024;

export interface ReviewView {
  asset: ReviewAsset;
  comments: ReviewComment[];
  manage: boolean;
  user: string | null;
}

// ---------- reviewer identity (share links) ----------

function stored(key: string, make: () => string): string {
  try {
    let v = localStorage.getItem(key);
    if (!v) localStorage.setItem(key, (v = make()));
    return v;
  } catch {
    return make();
  }
}

/** Lets an anonymous reviewer edit and delete their own comments. */
const reviewerKey = () => stored("review:key", () => crypto.randomUUID());

export const reviewerName = () => stored("review:name", () => "");
export function setReviewerName(name: string) {
  try {
    localStorage.setItem("review:name", name);
  } catch {
    /* private mode */
  }
}

// ---------- requests ----------

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      "x-review-key": reviewerKey(),
    },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const listReviewAssets = () => call<ReviewAsset[]>("/api/review");

export async function uploadReviewFile(
  file: File,
  onProgress: (pct: number) => void,
  to: { assetId?: string; projectId?: string } = {},
): Promise<ReviewAsset> {
  const target: Record<string, string> = to.assetId
    ? { assetId: to.assetId }
    : to.projectId
      ? { projectId: to.projectId }
      : {};
  return chunkedUpload<ReviewAsset>(
    "/api/review/uploads",
    "/api/review/uploads",
    file,
    { name: file.name, mime: file.type || "video/mp4", ...target },
    onProgress,
  );
}

export const patchReviewAsset = (
  id: string,
  patch: {
    name?: string;
    projectId?: string | null;
    share?: SharePatch;
    finished?: boolean;
  },
) => call<ReviewAsset>(`/api/review/assets/${id}`, send("PATCH", patch));

/** Admins: a copy on the demo account, for "See the demo" on the login screen. */
export const copyReviewAssetToDemo = (id: string) =>
  call<{ id: string }>(`/api/review/assets/${id}/demo`, send("POST"));

/** `from`'s versions go on top of `onto`'s stack; `from` is gone after. */
export const stackReviewAssets = (onto: string, from: string) =>
  call<ReviewAsset>(`/api/review/assets/${onto}/stack`, send("POST", { from }));

/** Captions burned in, made from `madeFrom` (a version without captions), or not captioned. */
export const markCaptioned = (id: string, n: number, patch: { captioned: boolean; madeFrom?: number | null }) =>
  call<ReviewAsset>(`/api/review/assets/${id}/v/${n}`, send("PATCH", patch));

/** Version `n` leaves the stack as its own video; without `n` the whole stack comes apart. */
export const unstackReviewAsset = (id: string, n?: number) =>
  call<ReviewAsset>(`/api/review/assets/${id}/unstack`, send("POST", n === undefined ? undefined : { n }));

/** Reorder a stack: every version number, V1 first. The top one names the video. */
export const reorderReviewStack = (id: string, order: number[]) =>
  call<ReviewAsset>(`/api/review/assets/${id}/order`, send("POST", { order }));

export const listReviewProjects = () => call<ReviewProject[]>("/api/review/projects");
export const createReviewProject = (name: string) =>
  call<ReviewProject>("/api/review/projects", send("POST", { name }));
export const patchReviewProject = (id: string, patch: { name?: string; share?: SharePatch }) =>
  call<ReviewProject>(`/api/review/projects/${id}`, send("PATCH", patch));
/** Its videos move to the top level; nothing is deleted with it. */
export const deleteReviewProject = (id: string) =>
  call<{ ok: true }>(`/api/review/projects/${id}`, send("DELETE"));

/** A shared project as its reviewers see it. */
export const getSharedProject = (token: string) =>
  call<{ name: string; assets: ReviewAsset[] }>(`/api/review/p/${token}`);

// ---------- trash (30 days) ----------

export const listReviewTrash = () => call<ReviewAsset[]>("/api/review/trash");
export const restoreReviewAsset = (id: string) =>
  call<ReviewAsset>(`/api/review/trash/${id}/restore`, send("POST"));
export const deleteForever = (id: string) => call<{ ok: true }>(`/api/review/trash/${id}`, send("DELETE"));
export const trashThumbUrl = (id: string) => `/api/review/trash/${id}/thumb`;

// ---------- notifications ----------

export const listNotifications = () =>
  call<{ items: ReviewNote[]; unread: number }>("/api/review/notifications");
/** Marks `ids` read, or all of them. */
export const markNotificationsRead = (ids?: string[]) =>
  call<{ ok: true }>("/api/review/notifications/read", send("POST", ids ? { ids } : {}));

export const deleteReviewAsset = (id: string) =>
  call<{ ok: true }>(`/api/review/assets/${id}`, send("DELETE"));

// ---------- Caption Studio (same file on the server, never re-uploaded) ----------

/** The Caption Studio project for a version: its linked one, or a new one. */
/** Delete the video files of the versions before n (their comments stay). */
export const clearEarlierVersions = (assetId: string, n: number) =>
  call<{ asset: ReviewAsset; freed: number }>(`/api/review/assets/${assetId}/v/${n}/clear-earlier`, send("POST"));

export const openInCaptionStudio = (assetId: string, n: number) =>
  call<{ projectId: string }>(`/api/review/assets/${assetId}/v/${n}/captions`, send("POST"));

/** Everything the review page does, for the owner or a share link. */
export function reviewApi(base: string) {
  return {
    get: () => call<ReviewView>(base),
    media: (v: FileRef, file: "play" | "thumb" | "download") => mediaUrl(base, v, file),
    comment: (body: {
      version: number;
      text: string;
      t?: number;
      tEnd?: number;
      parentId?: string;
      drawing?: Stroke[];
      author?: string;
      /** Ids from uploadRef on this version. */
      refs?: string[];
    }) => call<ReviewComment>(`${base}/comments`, send("POST", body)),
    /** An image or video for the comment being written; send its id with it. */
    uploadRef: async (n: number, file: File) => {
      if (file.size > MAX_REF_BYTES) throw new Error("Over 50 MB: trim it first");
      const res = await fetch(`${base}/v/${n}/refs?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error || `Upload failed (${res.status})`);
      return j as ReviewRef;
    },
    /** A reference as uploaded (`file`) or as the AI reads it (`look`, a JPEG). */
    refUrl: (n: number, id: string, file: "file" | "look") => `${base}/v/${n}/refs/${id}/${file}`,
    editComment: (id: string, patch: { text?: string; resolved?: boolean }) =>
      call<ReviewComment>(`${base}/comments/${id}`, send("PATCH", patch)),
    deleteComment: (id: string) => call<{ ok: true }>(`${base}/comments/${id}`, send("DELETE")),
    approve: (status: Approval, author?: string) =>
      call<ReviewAsset>(`${base}/approval`, send("POST", { status, author })),
  };
}

/** Thumbnail of the newest version; `base` is the API path of that video. */
/** Stacking reuses version numbers for other files, and media is cached for
 *  an hour: the version's createdAt (it moves with the file) keeps URLs apart. */
type FileRef = { n: number; createdAt: number };
const mediaUrl = (base: string, v: FileRef, file: string) => `${base}/v/${v.n}/${file}?c=${v.createdAt}`;

export const thumbUrl = (a: ReviewAsset, base = `/api/review/assets/${a.id}`) => {
  const v = a.versions.at(-1);
  return v ? mediaUrl(base, v, "thumb") : "";
};
export const versionThumbUrl = (id: string, v: FileRef) => mediaUrl(`/api/review/assets/${id}`, v, "thumb");

export const shareUrl = (token: string) => `${window.location.origin}/r/${token}`;
export const projectShareUrl = (token: string) => `${window.location.origin}/rp/${token}`;

// ---------- time ----------

const pad = (n: number) => String(n).padStart(2, "0");

/** Frame index at time t (stable for times set by `frameTime`). */
export const frameAt = (t: number, fps: number) => Math.floor(t * fps + 1e-6);
/** A time safely inside frame f, so seeking there shows that frame. */
export const frameTime = (f: number, fps: number) => (Math.max(0, f) + 0.1) / fps;

/** Non-drop-frame timecode HH:MM:SS:FF, or M:SS without fps. */
export function timecode(t: number, fps: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  if (!fps) {
    const s = Math.floor(t);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }
  const base = Math.round(fps);
  const frames = frameAt(t, fps);
  const secs = Math.floor(frames / base);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(frames % base)}`;
}
