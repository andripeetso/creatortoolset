import { chunkedUpload, json, putDirect, xhrSend } from "@/lib/uploads";
import type { ScreenEvents, ScreenLook } from "./screen-recording";
import type { TimelineView } from "@contracts/timeline-import";
import type { UploadRelayTus, UploadRelayView } from "@contracts/storage";

/** Review — Frame.io-style video review. Server: api/review.ts. */

export type Approval = "none" | "in_progress" | "needs_review" | "changes" | "approved";

export const APPROVAL: Record<Approval, { label: string; dot: string }> = {
  none: { label: "No status", dot: "bg-zinc-500" },
  in_progress: { label: "In progress", dot: "bg-sky-400" },
  needs_review: { label: "Needs review", dot: "bg-amber-400" },
  changes: { label: "Changes requested", dot: "bg-rose-500" },
  approved: { label: "Approved", dot: "bg-emerald-400" },
};

/** An AI Editor preview's sound in parts (the player's voice controls play them). */
export type StemSet = { groups: { key: string; label: string; mix: number }[]; fx: string[]; voice: string; duration: number };

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
  /** (owners) a screen recording from the Mac app with its pointer log: the Zoom & pointer editor opens on it. */
  screen?: boolean;
  /** The timeline file from the editing app it came with (OTIO, XML, EDL); shows under the player. */
  timelineFile?: string;
  /** It has a timeline to show under the player. */
  timeline?: boolean;
  /** (managers) the AI Editor draft it previews: its timeline, camera view and grade come from the editor. */
  edit?: { project: string; draft: string };
  /** (managers) a link back to what made it (a plug-in's own page). */
  source?: { kind: string; id: string; label: string; href: string };
  /** Its sound in parts (v<n>/stems/): the player's voice controls. */
  stems?: StemSet;
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
  /** Plug-in data sent with the comment, keyed by plug-in id (e.g. timeline edits). */
  plugins?: Record<string, unknown>;
  /** The timeline clip it is about (a version with a timeline). */
  anchor?: ReviewAnchor;
  /** Every clip it is about when it is about several (the first is `anchor`). */
  anchors?: ReviewAnchor[];
  resolved?: boolean;
  createdAt: number;
  editedAt?: number;
  mine: boolean;
}

/** A clip on the version's timeline, by its track and first frame. */
export type ReviewAnchor = { track: string; rec: number; len: number; label: string };
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

/** A screen recording's pointer log and the look saved for it (null until one is). */
export const getScreenRecording = (assetId: string, n: number) =>
  call<{ events: ScreenEvents; look: ScreenLook | null }>(`/api/review/assets/${assetId}/v/${n}/screen`);
export const saveScreenLook = (assetId: string, n: number, look: ScreenLook) =>
  call<{ ok: true }>(`/api/review/assets/${assetId}/v/${n}/screen/look`, send("PUT", look));

/** Sends a video (chunked, resumable). With its timeline file, that file is attached to
 *  the new version once the video is in; if the timeline is refused the video still stays,
 *  and the timeline can be added under the player. */
export async function uploadReviewFile(
  file: File,
  onProgress: (pct: number) => void,
  to: { assetId?: string; projectId?: string } = {},
  timeline?: File,
): Promise<ReviewAsset> {
  const target: Record<string, string> = to.assetId
    ? { assetId: to.assetId }
    : to.projectId
      ? { projectId: to.projectId }
      : {};
  const fields = { name: file.name, mime: file.type || "video/mp4", ...target };
  // the server picks the relay (api/uploads/relay): parts through this server, or straight to its bucket
  const relay = await fetch("/api/uploads/relay").then((r) => json<UploadRelayView>(r));
  const plugged = relay.active !== "direct" && relay.active !== "chunked";
  const asset =
    relay.active === "direct"
      ? await directUpload<ReviewAsset>(file, fields, onProgress)
      : (plugged ? await tusRelayUpload<ReviewAsset>(file, fields, onProgress) : null) ??
        (await chunkedUpload<ReviewAsset>("/api/uploads/relay", "/api/uploads/relay", file, fields, onProgress));
  if (!timeline) return asset;
  const n = Math.max(...asset.versions.map((v) => v.n));
  return attachTimeline(asset.id, n, timeline).catch(() => asset);
}

type TusSaved = { id: string; url: string; tus: UploadRelayTus };
const isVideoFile = (f: File) =>
  f.type.startsWith("video/") || /\.(mov|mp4|m4v|mkv|webm|avi|mxf|mts)$/i.test(f.name);
const tusPause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How much of this upload the relay has (TUS HEAD); null = gone, start over. */
async function tusOffset(s: TusSaved): Promise<number | null> {
  const res = await fetch(s.url, { method: "HEAD", headers: s.tus.headers }).catch(() => null);
  return res?.ok ? Number(res.headers.get("Upload-Offset")) || 0 : null;
}

/** A plug-in relay (its TUS settings come from the server, api/uploads/relay?relay=tus): the file goes to the relay in
 *  parts, resumes where the relay has it, then the server takes it over. null = the relay can't take this file (not a
 *  video, or it refused the first part three times): the caller sends it through this server. */
async function tusRelayUpload<T>(
  file: File,
  fields: Record<string, string>,
  onProgress: (pct: number) => void,
): Promise<T | null> {
  if (!isVideoFile(file)) return null;
  const key = `upload-relay:${file.name}:${file.size}:${file.lastModified}:${JSON.stringify(fields)}`;
  const forget = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // private window: nothing saved
    }
  };
  let s: TusSaved | null = null;
  try {
    s = JSON.parse(localStorage.getItem(key) ?? "null") as TusSaved | null;
  } catch {
    // nothing saved
  }
  let offset = s ? await tusOffset(s) : null;
  if (!s || offset === null) {
    const init = await fetch("/api/uploads/relay?relay=tus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, size: file.size }),
    }).then((r) => json<{ id: string; tus?: UploadRelayTus }>(r));
    if (!init.tus) throw new Error("The upload relay changed while this started: try again");
    const made = await fetch(init.tus.createUrl, {
      method: "POST",
      headers: { ...init.tus.headers, "Upload-Length": String(file.size), "Upload-Metadata": init.tus.metadata },
    }).catch(() => null);
    const location = made?.status === 201 ? made.headers.get("Location") : null;
    if (!location) return null;
    s = { id: init.id, url: new URL(location, init.tus.createUrl).href, tus: init.tus };
    offset = 0;
    try {
      localStorage.setItem(key, JSON.stringify(s));
    } catch {
      // private window: no resume, the upload still works
    }
  }
  const saved = s;
  const partSize = saved.tus.partSize;
  let failures = 0;
  while (offset < file.size) {
    const at: number = offset;
    try {
      const xhr = await xhrSend(
        "PATCH",
        saved.url,
        { ...saved.tus.headers, "Upload-Offset": String(at), "Content-Type": "application/offset+octet-stream" },
        file.slice(at, Math.min(file.size, at + partSize)),
        (loaded) => onProgress(Math.min(99, Math.round(((at + loaded) / file.size) * 100))),
      );
      offset = Number(xhr.getResponseHeader("Upload-Offset")) || Math.min(file.size, at + partSize);
      failures = 0;
    } catch (e) {
      failures++;
      // never reached the relay at all: this network can't, send it through this server
      if (at === 0 && failures >= 3) return null;
      if (failures >= 10) throw e;
      await tusPause(Math.min(1000 * 2 ** failures, 30_000));
      const now = await tusOffset(saved);
      if (now === null) {
        forget();
        throw e;
      }
      offset = now;
    }
  }
  // the bytes are at the relay: from here on only finish, never start over
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`/api/uploads/relay/${saved.id}/complete`, { method: "POST" }).catch(() => null);
    if (res?.ok) {
      forget();
      onProgress(100);
      return (await res.json()) as T;
    }
    if ((res && res.status < 500) || attempt >= 5) {
      const j = (await res?.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error || "Couldn't finish the upload");
    }
    await tusPause(2000 * (attempt + 1)); // this server restarting
  }
}

/** The direct relay: the server hands presigned part URLs, the parts go straight to its bucket, and complete takes the ETags.
 *  No resume after a closed tab (chunked uploads have it): a retry starts the upload again. */
async function directUpload<T>(
  file: File,
  fields: Record<string, string>,
  onProgress: (pct: number) => void,
): Promise<T> {
  const init = await fetch("/api/uploads/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...fields, size: file.size }),
  }).then((r) => json<{ id: string; partSize: number; urls?: string[] }>(r));
  if (!init.urls) throw new Error("The upload relay changed while this started: try again");
  const parts = await putDirect(file, { partSize: init.partSize, urls: init.urls }, (sent) =>
    onProgress(Math.min(99, Math.round((sent / file.size) * 100))),
  );
  const done = await fetch(`/api/uploads/relay/${init.id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts }),
  }).then((r) => json<T>(r));
  onProgress(100);
  return done;
}

/** Its timeline from the editing app (OTIO, FCP 7 XML, FCPXML, EDL), shown under the player. */
export const attachTimeline = (assetId: string, n: number, file: File) =>
  call<ReviewAsset>(`/api/review/assets/${assetId}/v/${n}/timeline?name=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    body: file,
  });

export const patchReviewAsset = (
  id: string,
  patch: {
    name?: string;
    projectId?: string | null;
    share?: SharePatch;
    finished?: boolean;
  },
) => call<ReviewAsset>(`/api/review/assets/${id}`, send("PATCH", patch));

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
    stem: (v: FileRef, file: string) => mediaUrl(base, v, `stems/${file}`),
    /** The version's timeline (tracks, clips, markers), or 404 when it has none. */
    timeline: (n: number) => call<TimelineView>(`${base}/v/${n}/timeline`),
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
      /** Plug-in data (see ReviewComment.plugins); the server accepts it from managers only. */
      plugins?: Record<string, unknown>;
      anchor?: ReviewAnchor;
      anchors?: ReviewAnchor[];
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
