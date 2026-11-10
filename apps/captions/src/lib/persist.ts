import {
  bumpPosIdCounter,
  bumpTextIdCounter,
  clearEditHistory,
  getClipSnapshot,
  isEditorBusy,
  loadClipSlots,
  setClipRemovedHook,
  setClipReorderedHook,
  setSaveClipHook,
  useStudio,
  type ClipInfo,
  type ClipSnapshot,
} from "./store";
import { storedAutoCadence } from "./cadence-preference";
import { onTopic } from "./sync";
import { bumpCueIdCounter, type CadenceFit } from "./captions";
import {
  deleteLocalRecoveryProject,
  listLocalRecoveryProjects,
  renameLocalRecoveryProject,
  restoreLocalRecoveryProject,
} from "./local-recovery";
import {
  DEFAULT_STYLE,
  type CaptionStyle,
  type Cue,
  type PosSegment,
  type TextOverlay,
  type Word,
} from "./types";

/**
 * Session persistence. A project is a pool of clips: every imported
 * source uploads once (direct multipart object storage in production, with a
 * resumable app-server fallback) and the server builds an editing proxy. Edits
 * to the active clip autosave
 * (debounced) and background-transcribed clips save directly. The
 * import screen lists saved sessions to reopen.
 */

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  clipCount: number;
  /** First clip of the pool — its /thumb endpoint is the project tile image. */
  thumbClipId: string | null;
  /** This browser has a complete editor snapshot, even if cloud sync failed. */
  locallyAvailable?: boolean;
  /** No confirmed server project exists yet; local work remains recoverable. */
  localOnly?: boolean;
  /** The local copy was preserved because the server revision changed. */
  serverConflict?: boolean;
}

export interface DeletedSessionMeta {
  id: string;
  name: string;
  deletedAt: number;
  recoverableUntil: number;
  clipCount: number;
}

interface ServerClip {
  id: string;
  name?: string;
  duration?: number;
  srcWidth?: number;
  srcHeight?: number;
  srcFps?: number;
  hasOriginal?: boolean;
  originalBytes?: number;
  words?: Word[];
  /** The clip's first engine transcript (apply-master's diff baseline). */
  originalWords?: Word[];
  cues?: Cue[];
  style?: Partial<CaptionStyle>;
  posSegments?: PosSegment[];
  texts?: TextOverlay[];
  cadenceApplied?: boolean;
  /** Box capacity the cadence grouping was sized for (stale detection). */
  cadenceFit?: CadenceFit | null;
  /** The cadence grouping was edited after the pass (offers a re-match). */
  cadenceDirty?: boolean;
  done?: boolean;
  peaks?: number[] | null;
}

interface ProjectData {
  id: string;
  name: string;
  revision?: number;
  fps: number | null;
  model: string | null;
  autoCadence?: boolean | null;
  /** The script the video was filmed from (see the store's `script`). */
  script?: string | null;
  clips: ServerClip[];
}

export async function listSessions(): Promise<SessionMeta[]> {
  const local = await listLocalRecoveryProjects().catch(() => []);
  let remote: SessionMeta[] = [];
  try {
    const res = await fetch("/api/projects");
    if (res.ok) remote = await res.json();
  } catch {
    // Offline is a normal state: the local project list still works.
  }
  const merged = new Map(remote.map((project) => [project.id, project]));
  for (const project of local) {
    const server = merged.get(project.id);
    merged.set(project.id, {
      ...(server ?? {
        id: project.id,
        createdAt: project.updatedAt,
      }),
      name:
        !server || project.updatedAt >= server.updatedAt
          ? project.name
          : server.name,
      updatedAt: Math.max(project.updatedAt, server?.updatedAt ?? 0),
      duration: project.duration || server?.duration || 0,
      clipCount: project.clipCount || server?.clipCount || 0,
      thumbClipId: server?.thumbClipId ?? project.thumbClipId,
      locallyAvailable: true,
      localOnly: !server || !project.serverProjectReady,
      serverConflict: project.serverConflict,
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id: string): Promise<void> {
  await Promise.all([
    deleteLocalRecoveryProject(id).catch(() => {}),
    fetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => null),
  ]);
}

export async function listDeletedSessions(): Promise<DeletedSessionMeta[]> {
  try {
    const res = await fetch("/api/projects/trash");
    return res.ok ? res.json() : [];
  } catch {
    return [];
  }
}

export async function restoreDeletedSession(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/projects/${id}/restore`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function permanentlyDeleteSession(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/projects/trash/${id}`, { method: "DELETE" });
    if (!res.ok) return false;
    await deleteLocalRecoveryProject(id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Rename a project that isn't loaded (meta-only — its data is untouched). */
export async function renameSession(
  id: string,
  name: string,
): Promise<boolean> {
  const local = await renameLocalRecoveryProject(id, name).catch(() => false);
  try {
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.ok || local;
  } catch {
    return local;
  }
}

/** Per-clip defaults for saves that predate newer fields. */
function clipSlotFromServer(cm: ServerClip): ClipSnapshot {
  const cues = cm.cues ?? [];
  const words = cm.words ?? cues.flatMap((c) => c.words);
  const texts = (cm.texts ?? []).map((t) => ({
    ...t,
    w: t.w ?? 40,
    fontFamily: t.fontFamily ?? "Anton",
    outlineColor: t.outlineColor ?? "#000000",
    outlineWidth: t.outlineWidth ?? 4,
    shadowDepth: t.shadowDepth ?? 0,
    boxEnabled: t.boxEnabled ?? false,
    boxColor: t.boxColor ?? "#000000",
    rotation: t.rotation ?? 0,
  }));
  return {
    words,
    cues,
    originalWords: cm.originalWords ?? null,
    posSegments: cm.posSegments ?? [],
    texts,
    cadenceApplied: cm.cadenceApplied ?? false,
    cadenceFit: cm.cadenceFit ?? null,
    cadenceDirty: cm.cadenceDirty ?? false,
    done: cm.done ?? false,
    // fitBox is always on now; old saves also predate the lowercase flag
    style: {
      ...DEFAULT_STYLE,
      ...(cm.style ?? {}),
      fitBox: true,
      lowercase: cm.style?.lowercase ?? false,
    },
    peaks: cm.peaks?.length ? Float32Array.from(cm.peaks) : null,
    pcm: null,
    file: null,
  };
}

export async function loadSession(
  id: string,
  options?: { server?: boolean },
): Promise<boolean> {
  // Prefer the browser copy. It can be newer than the cloud copy and retains
  // edits plus the original File even when upload/sync failed.
  if (
    !options?.server &&
    (await restoreLocalRecoveryProject(id).catch(() => false))
  )
    return true;
  let p: ProjectData;
  try {
    const res = await fetch(`/api/projects/${id}`);
    if (!res.ok) return false;
    p = await res.json();
    if (!p || !Array.isArray(p.clips)) return false;
  } catch {
    return false; // network/parse failure — the opener must not hang
  }

  // dropping whatever is open: free its local clip resources
  const prev = useStudio.getState();
  for (const c of prev.clips) {
    if (c.videoUrl.startsWith("blob:")) URL.revokeObjectURL(c.videoUrl);
  }
  const slots = new Map<string, ClipSnapshot>();
  const clips: ClipInfo[] = p.clips.map((cm) => {
    slots.set(cm.id, clipSlotFromServer(cm));
    const transcribed =
      (cm.words?.length ?? 0) > 0 || (cm.cues?.length ?? 0) > 0;
    return {
      id: cm.id,
      name: cm.name ?? p.name,
      videoUrl: `/api/projects/${id}/clips/${cm.id}/video`,
      duration: cm.duration ?? 0,
      sourceWidth: cm.srcWidth ?? 0,
      sourceHeight: cm.srcHeight ?? 0,
      srcFps: cm.srcFps ?? null,
      status: { phase: transcribed ? "done" : "idle" },
      transcribed,
      uploadState: "done",
      uploadPct: 100,
      uploadError: null,
      hasOriginal: !!cm.hasOriginal,
      originalBytes: cm.originalBytes ?? 0,
      done: cm.done ?? false,
    };
  });
  // keep future generated ids clear of the loaded ones (across ALL clips)
  let cueMax = 0;
  let posMax = 0;
  let textMax = 0;
  for (const slot of slots.values()) {
    cueMax = slot.cues.reduce((a, c) => Math.max(a, c.id + 1), cueMax);
    posMax = slot.posSegments.reduce((a, s) => Math.max(a, s.id + 1), posMax);
    textMax = slot.texts.reduce((a, t) => Math.max(a, t.id + 1), textMax);
  }
  bumpCueIdCounter(cueMax);
  bumpPosIdCounter(posMax);
  bumpTextIdCounter(textMax);
  clearEditHistory();

  const first = clips[0];
  const firstSlot = first ? slots.get(first.id)! : null;
  // swap the whole slot registry via the store's load path
  useStudio.setState({
    projectId: id,
    serverProjectReady: true,
    serverRevision: p.revision ?? 0,
    serverConflict: false,
    setupPending: false,
    saveState: "saved",
    saveError: null,
    fileName: p.name,
    clips,
    activeClipId: first?.id ?? null,
    model: p.model ?? useStudio.getState().model,
    autoCadence: p.autoCadence ?? storedAutoCadence(),
    script: p.script ?? "",
    scriptFixes: {},
    scriptCheckError: null,
    // a saved fps wins (it may be the user's choice); the probed source
    // rate fills in for projects saved before it existed
    fps: p.fps ?? first?.srcFps ?? 30,
    fpsManual: p.fps != null,
    ...(first && firstSlot
      ? {
          videoUrl: first.videoUrl,
          importedFile: null,
          words: firstSlot.words,
          cues: firstSlot.cues,
          posSegments: firstSlot.posSegments,
          texts: firstSlot.texts,
          cadenceApplied: firstSlot.cadenceApplied,
          cadenceFit: firstSlot.cadenceFit,
          cadenceDirty: firstSlot.cadenceDirty,
          done: firstSlot.done,
          style: firstSlot.style,
          peaks: firstSlot.peaks,
          pcm: null,
          srcFps: first.srcFps,
          sourceWidth: first.sourceWidth,
          sourceHeight: first.sourceHeight,
          duration: first.duration,
          status: first.status,
        }
      : {
          videoUrl: null,
          importedFile: null,
          words: [],
          cues: [],
          posSegments: [],
          texts: [],
          cadenceApplied: false,
          cadenceFit: null,
          cadenceDirty: false,
          done: false,
          style: { ...DEFAULT_STYLE, fitBox: true },
          peaks: null,
          pcm: null,
          srcFps: null,
          sourceWidth: 0,
          sourceHeight: 0,
          duration: 0,
          status: { phase: "idle" },
        }),
    selectedTextId: null,
    editingTextId: null,
    currentTime: 0,
    playing: false,
    applyingMaster: false,
    applyMasterProgress: null,
    masterApplyResults: null,
    masterApplyInserted: null,
    masterApplyCorrected: null,
    rangeSel: null,
    selectedClipIds: [],
  });
  loadClipSlots([...slots]);
  serverRevisions.set(id, p.revision ?? 0);
  return true;
}

/** Duplicate a project on the server into the signed-in user's library (hosted admins only; the server refuses others). */
export async function copySessionToLibrary(id: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch(`/api/projects/${id}/copy`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown; name?: unknown };
    if (typeof body.id !== "string" || !body.id) return null;
    return { id: body.id, name: typeof body.name === "string" ? body.name : "copy" };
  } catch {
    return null;
  }
}

type StudioSnapshot = ReturnType<typeof useStudio.getState>;

function buildPayload(s: StudioSnapshot): string {
  const clip = s.clips.find((c) => c.id === s.activeClipId);
  return JSON.stringify({
    name: s.fileName,
    fps: s.fps,
    model: s.model,
    autoCadence: s.autoCadence,
    script: s.script,
    clipOrder: s.clips.map((c) => c.id),
    clip: clip
      ? {
          id: clip.id,
          name: clip.name,
          duration: s.duration,
          style: s.style,
          words: s.words,
          // originalWords lives slot-side only (never edited); the active
          // clip's slot copy is the current one
          originalWords: getClipSnapshot(clip.id)?.originalWords ?? null,
          cues: s.cues,
          posSegments: s.posSegments,
          texts: s.texts,
          cadenceApplied: s.cadenceApplied,
          cadenceFit: s.cadenceFit,
          cadenceDirty: s.cadenceDirty,
          done: s.done,
          peaks: s.peaks
            ? Array.from(s.peaks, (v) => Math.round(v * 1000) / 1000)
            : null,
        }
      : undefined,
  });
}

const serverRevisions = new Map<string, number>();
const syncTails = new Map<string, Promise<void>>();

const newMutationId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function patchActiveProject(
  id: string,
  patch: Partial<ReturnType<typeof useStudio.getState>>,
): void {
  if (useStudio.getState().projectId === id) useStudio.setState(patch);
}

async function syncData(id: string, payload: string): Promise<void> {
  const mutationId = newMutationId();
  const snapshot = JSON.parse(payload) as Record<string, unknown>;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const active = useStudio.getState();
    const baseRevision =
      serverRevisions.get(id) ??
      (active.projectId === id ? active.serverRevision : 0);
    try {
      const res = await fetch(`/api/projects/${id}/sync`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision, mutationId, snapshot }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 404) {
        // The server copy is permanently gone (trash-purged or hard-deleted)
        // — retrying forever just storms 404s. Keep the local copy, stop
        // syncing, and don't auto-recreate it.
        patchActiveProject(id, {
          saveState: "error",
          saveError:
            "The server copy of this project was deleted. Your edits remain saved on this device only.",
          serverProjectReady: false,
          serverConflict: true,
        });
        return;
      }
      if (res.status === 409 && body?.code === "REVISION_CONFLICT") {
        patchActiveProject(id, {
          saveState: "error",
          saveError:
            "A newer server version exists. Your local edits are still safe; reload or duplicate before resolving it.",
          serverConflict: true,
        });
        return;
      }
      if (!res.ok || !Number.isSafeInteger(body?.revision)) {
        throw new Error(body?.error || `Save failed (${res.status})`);
      }
      serverRevisions.set(id, body.revision);
      patchActiveProject(id, {
        serverRevision: body.revision,
        serverConflict: false,
        saveState: pendingSave ? "saving" : "saved",
        saveError: null,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await pause(Math.min(400 * 2 ** attempt, 4000));
    }
  }
  patchActiveProject(id, {
    saveState: "error",
    saveError:
      lastError instanceof Error ? lastError.message : String(lastError),
  });
}

async function putData(id: string, payload: string): Promise<void> {
  patchActiveProject(id, { saveState: "saving" });
  const previous = syncTails.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => syncData(id, payload));
  syncTails.set(id, current);
  await current;
  if (syncTails.get(id) === current) syncTails.delete(id);
}

async function saveData(): Promise<void> {
  const s = useStudio.getState();
  if (!s.projectId || !s.serverProjectReady) return;
  await putData(s.projectId, buildPayload(s));
}

/**
 * Save a NON-active clip (its transcript landed from the batch queue).
 * Payload comes from the clip's slot; project settings ride along.
 */
async function saveClip(clipId: string): Promise<void> {
  const s = useStudio.getState();
  if (!s.projectId || !s.serverProjectReady) return;
  const clip = s.clips.find((c) => c.id === clipId);
  const slot = getClipSnapshot(clipId);
  if (!clip || !slot) return;
  await putData(
    s.projectId,
    JSON.stringify({
      name: s.fileName,
      fps: s.fps,
      model: s.model,
      autoCadence: s.autoCadence,
      script: s.script,
      clipOrder: s.clips.map((c) => c.id),
      clip: {
        id: clip.id,
        name: clip.name,
        duration: clip.duration,
        style: slot.style,
        words: slot.words,
        originalWords: slot.originalWords,
        cues: slot.cues,
        posSegments: slot.posSegments,
        texts: slot.texts,
        cadenceApplied: slot.cadenceApplied,
        cadenceFit: slot.cadenceFit,
        cadenceDirty: slot.cadenceDirty,
        done: slot.done,
        peaks: slot.peaks
          ? Array.from(slot.peaks, (v) => Math.round(v * 1000) / 1000)
          : null,
      },
    }),
  );
}

// pending debounced save — snapshotted so it still targets the right
// project even if the user switches projects before the timer fires
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: (() => Promise<void>) | null = null;

function scheduleSave(s: StudioSnapshot): void {
  const id = s.projectId!;
  const payload = buildPayload(s);
  pendingSave = () => putData(id, payload);
  // Mark dirty immediately, including during the debounce window. Otherwise
  // the UI can falsely say SAVED for 1.2 seconds after every edit.
  useStudio.setState({ saveState: "saving" });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const run = pendingSave;
    pendingSave = null;
    if (run) void run();
  }, 1200);
}

/** Fire any pending debounced save immediately (call before switching projects). */
export async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const run = pendingSave;
  pendingSave = null;
  if (run) await run();
  const id = useStudio.getState().projectId;
  if (id) await syncTails.get(id);
}

/* ---- uploads: one clip at a time, in pool order ---- */

const uploadQueue: string[] = [];
let uploading = false;
let creatingProject: Promise<void> | null = null;

function patchClip(id: string, patch: Partial<ClipInfo>): void {
  useStudio.setState((s) => {
    // upload progress fires many times per whole percent: a no-op patch
    // keeps the clip list as-is, so its subscribers don't re-render
    const clip = s.clips.find((c) => c.id === id);
    const keys = Object.keys(patch) as (keyof ClipInfo)[];
    if (!clip || keys.every((k) => clip[k] === patch[k])) return s;
    return {
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    };
  });
}

function queueUpload(clipId: string): void {
  if (!uploadQueue.includes(clipId)) uploadQueue.push(clipId);
  void pumpUploads();
}

async function pumpUploads(): Promise<void> {
  if (uploading) return;
  uploading = true;
  try {
    while (uploadQueue.length) {
      const clipId = uploadQueue.shift()!;
      await uploadClip(clipId);
    }
  } finally {
    uploading = false;
  }
}

interface UploadResp {
  offset?: number;
  complete?: boolean;
  proxyReady?: boolean;
  hasOriginal?: boolean;
  originalBytes?: number;
  srcWidth?: number;
  srcHeight?: number;
  srcFps?: number;
  error?: string;
}

interface MultipartInit {
  mode: "object" | "legacy";
  complete?: boolean;
  uploadId?: string;
  partSize?: number;
  size?: number;
  uploadedParts?: { partNumber: number; size: number }[];
  error?: string;
}

function putObjectPart(
  url: string,
  chunk: Blob,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Object upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during object upload"));
    xhr.onabort = () => reject(new Error("Object upload aborted"));
    xhr.send(chunk);
  });
}

async function uploadOriginalToObjectStorage(
  projectId: string,
  clipId: string,
  file: File,
): Promise<UploadResp | null> {
  const initRes = await fetch(
    `/api/projects/${projectId}/clips/${clipId}/original/multipart`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: file.size, contentType: file.type }),
    },
  );
  const init = (await initRes.json().catch(() => null)) as MultipartInit | null;
  if (!initRes.ok || !init) {
    throw new Error(
      init?.error || `Object upload setup failed (${initRes.status})`,
    );
  }
  if (init.mode === "legacy") return null;
  if (init.complete) {
    return {
      complete: true,
      hasOriginal: true,
      originalBytes: init.size ?? file.size,
      offset: init.size ?? file.size,
    };
  }
  if (!init.uploadId || !init.partSize) {
    throw new Error("Object upload setup was incomplete");
  }

  const uploaded = new Map(
    (init.uploadedParts ?? []).map((part) => [part.partNumber, part.size]),
  );
  const totalParts = Math.ceil(file.size / init.partSize);
  const progress = new Map<number, number>(uploaded);
  const updateProgress = () => {
    const bytes = [...progress.values()].reduce((sum, value) => sum + value, 0);
    patchClip(clipId, {
      uploadPct: Math.min(99, Math.round((bytes / file.size) * 100)),
    });
  };
  updateProgress();
  const pending = Array.from(
    { length: totalParts },
    (_, index) => index + 1,
  ).filter((partNumber) => !uploaded.has(partNumber));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const partNumber = pending[cursor++];
      const start = (partNumber - 1) * init.partSize!;
      const chunk = file.slice(
        start,
        Math.min(start + init.partSize!, file.size),
      );
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const signRes = await fetch(
            `/api/projects/${projectId}/clips/${clipId}/original/multipart/part`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ uploadId: init.uploadId, partNumber }),
            },
          );
          const signed = await signRes.json().catch(() => null);
          if (!signRes.ok || typeof signed?.url !== "string") {
            throw new Error(
              signed?.error || `Upload signing failed (${signRes.status})`,
            );
          }
          await putObjectPart(signed.url, chunk, (loaded) => {
            progress.set(partNumber, loaded);
            updateProgress();
          });
          progress.set(partNumber, chunk.size);
          updateProgress();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          progress.delete(partNumber);
          updateProgress();
          if (attempt < 4) await pause(Math.min(600 * 2 ** attempt, 5000));
        }
      }
      if (lastError) throw lastError;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(3, pending.length) }, worker),
  );

  const completeRes = await fetch(
    `/api/projects/${projectId}/clips/${clipId}/original/multipart/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: init.uploadId }),
    },
  );
  const complete = await completeRes.json().catch(() => null);
  if (!completeRes.ok) {
    throw new Error(
      complete?.error || `Upload completion failed (${completeRes.status})`,
    );
  }
  return complete as UploadResp;
}

function postVideoChunk(
  projectId: string,
  clipId: string,
  chunk: Blob,
  offset: number,
  total: number,
): Promise<UploadResp> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/projects/${projectId}/clips/${clipId}/original/chunk`,
    );
    xhr.responseType = "json";
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Upload-Length", String(total));
    // XHR has no timeout of its own: a stalled connection (slow source
    // drive, frozen network path) would otherwise hang the upload forever.
    // Abort after a progress silence so the resumable loop continues from
    // the server's durable offset instead of wedging the clip.
    const STALL_MS = 45_000;
    let stallTimer = window.setTimeout(() => xhr.abort(), STALL_MS);
    const resetStallWatchdog = () => {
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(() => xhr.abort(), STALL_MS);
    };
    const clearStallWatchdog = () => window.clearTimeout(stallTimer);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        resetStallWatchdog();
        patchClip(clipId, {
          uploadPct: Math.round(((offset + e.loaded) / total) * 100),
        });
      }
    };
    xhr.onload = () => {
      clearStallWatchdog();
      const resp = xhr.response as UploadResp | null;
      if (xhr.status >= 200 && xhr.status < 300 && resp) {
        resolve(resp);
      } else if (xhr.status === 409 && typeof resp?.offset === "number") {
        resolve(resp);
      } else {
        reject(new Error(resp?.error || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      clearStallWatchdog();
      reject(new Error("Network error during upload"));
    };
    xhr.onabort = () => {
      clearStallWatchdog();
      reject(
        new Error("Upload stalled — resuming from the last saved position"),
      );
    };
    xhr.send(chunk);
  });
}

async function sourceStatus(
  projectId: string,
  clipId: string,
): Promise<UploadResp> {
  const res = await fetch(
    `/api/projects/${projectId}/clips/${clipId}/original/status`,
  );
  if (!res.ok) throw new Error(`Source status failed (${res.status})`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Parallel offset-addressed upload (16 MiB parts, bounded concurrency) */
/* ------------------------------------------------------------------ */

interface PartsStatusResp extends UploadResp {
  partSize: number | null;
  total: number | null;
  received?: { partNumber: number; size: number }[];
}

/** Route exists on the server but this upload can't use it right now. */
class ParallelUnavailable extends Error {}

const PARALLEL_PART_BYTES = 16 * 1024 * 1024;
// Measured against production: each connection to the app server sustains
// only ~0.32 MB/s, and throughput scales linearly with concurrency (4-way
// 1.27 MB/s, 6-way 1.89 MB/s). Six workers ≈ 6× the old sequential speed.
const PARALLEL_WORKERS = 6;

async function originalPartsStatus(
  projectId: string,
  clipId: string,
): Promise<PartsStatusResp> {
  const res = await fetch(
    `/api/projects/${projectId}/clips/${clipId}/original/parts`,
  );
  if (res.status === 404) throw new ParallelUnavailable();
  if (!res.ok) throw new Error(`Parts status failed (${res.status})`);
  return res.json();
}

function postOriginalPart(
  projectId: string,
  clipId: string,
  partNumber: number,
  chunk: Blob,
  partSize: number,
  total: number,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/projects/${projectId}/clips/${clipId}/original/parts/${partNumber}`,
    );
    xhr.responseType = "json";
    xhr.setRequestHeader("Upload-Part-Size", String(partSize));
    xhr.setRequestHeader("Upload-Length", String(total));
    const STALL_MS = 45_000;
    let stallTimer = window.setTimeout(() => xhr.abort(), STALL_MS);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(() => xhr.abort(), STALL_MS);
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      window.clearTimeout(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const resp = xhr.response as { error?: string } | null;
        reject(new Error(resp?.error || `Part upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      window.clearTimeout(stallTimer);
      reject(new Error("Network error during part upload"));
    };
    xhr.onabort = () => {
      window.clearTimeout(stallTimer);
      reject(new Error("Part upload stalled — retrying"));
    };
    xhr.send(chunk);
  });
}

/**
 * Offset-addressed upload with a small worker pool. Returns null when the
 * server can't take the parallel route (older server, or a legacy sequential
 * upload already in flight) so the caller falls back cleanly.
 */
async function uploadOriginalParallel(
  projectId: string,
  clipId: string,
  file: File,
): Promise<UploadResp | null> {
  const startedAt = Date.now();
  const log = (message: string) =>
    console.log(`[cap-upload] +${Date.now() - startedAt}ms ${message}`);
  const status = await originalPartsStatus(projectId, clipId);
  if (status.complete) return status;
  const partSize = status.partSize ?? PARALLEL_PART_BYTES;
  if (!status.total) {
    // A legacy sequential .upload is mid-flight — that route owns it.
    const legacy = await sourceStatus(projectId, clipId).catch(() => null);
    if (legacy && (legacy.offset ?? 0) > 0 && !legacy.complete) {
      throw new ParallelUnavailable();
    }
  }
  if (status.total && status.total !== file.size) {
    throw new Error(
      "The source changed since the upload started — re-attach it to restart.",
    );
  }
  const totalParts = Math.ceil(file.size / partSize);
  const progress = new Map<number, number>(
    (status.received ?? []).map((part) => [part.partNumber, part.size]),
  );
  const updateProgress = () => {
    const bytes = [...progress.values()].reduce((sum, value) => sum + value, 0);
    patchClip(clipId, {
      uploadPct: Math.min(99, Math.round((bytes / file.size) * 100)),
    });
  };
  updateProgress();
  const pending = Array.from(
    { length: totalParts },
    (_, index) => index + 1,
  ).filter((partNumber) => !progress.has(partNumber));
  log(
    `parallel start clip=${clipId} parts=${totalParts} pending=${pending.length} partSize=${partSize}`,
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const partNumber = pending[cursor++];
      const start = (partNumber - 1) * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await postOriginalPart(
            projectId,
            clipId,
            partNumber,
            chunk,
            partSize,
            file.size,
            (loaded) => {
              progress.set(partNumber, loaded);
              updateProgress();
            },
          );
          progress.set(partNumber, chunk.size);
          updateProgress();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          progress.delete(partNumber);
          updateProgress();
          if (attempt < 4) await pause(Math.min(600 * 2 ** attempt, 5000));
        }
      }
      if (lastError) throw lastError;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_WORKERS, pending.length) }, worker),
  );
  log(`all parts stored — completing`);
  const completeRes = await fetch(
    `/api/projects/${projectId}/clips/${clipId}/original/complete`,
    { method: "POST" },
  );
  const complete = await completeRes.json().catch(() => null);
  if (!completeRes.ok) {
    throw new Error(
      complete?.error || `Upload completion failed (${completeRes.status})`,
    );
  }
  log(`parallel complete bytes=${file.size}`);
  return complete as UploadResp;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function sourceStatusWithRetry(
  projectId: string,
  clipId: string,
): Promise<UploadResp> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await sourceStatus(projectId, clipId);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await pause(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not resume the source upload");
}

async function uploadOriginalResumable(
  projectId: string,
  clipId: string,
  file: File,
): Promise<UploadResp> {
  const startedAt = Date.now();
  const log = (message: string) =>
    console.log(`[cap-upload] +${Date.now() - startedAt}ms ${message}`);
  log(`start clip=${clipId} bytes=${file.size}`);
  let status = await sourceStatusWithRetry(projectId, clipId);
  if (status.complete) return status;
  let offset = Math.min(Math.max(status.offset ?? 0, 0), file.size);
  log(`server offset=${offset} of ${file.size}`);
  patchClip(clipId, {
    uploadPct: Math.round((offset / file.size) * 100),
  });
  // The legacy route is sequential because each durable response advances the
  // resumable offset. Sixteen MiB keeps that safety while avoiding dozens of
  // request/response round trips to a remote app server for ordinary videos.
  const chunkBytes = 16 * 1024 * 1024;
  let failures = 0;
  while (offset < file.size) {
    const end = Math.min(offset + chunkBytes, file.size);
    try {
      log(`chunk ${offset}..${end} sending`);
      status = await postVideoChunk(
        projectId,
        clipId,
        file.slice(offset, end),
        offset,
        file.size,
      );
      failures = 0;
    } catch (error) {
      failures += 1;
      log(`chunk ${offset}..${end} failed (${failures}/6): ${error}`);
      if (failures >= 6) throw error;
      // Retrying the same offset is safe. If the server received the bytes
      // but the response was lost, it replies 409 with its durable offset and
      // the next iteration continues from there.
      await pause(Math.min(750 * 2 ** (failures - 1), 6000));
      continue;
    }
    const next = status.offset ?? offset;
    if (next <= offset && !status.complete) {
      throw new Error("Upload did not advance");
    }
    offset = next;
    patchClip(clipId, {
      uploadPct: Math.round((offset / file.size) * 100),
    });
  }
  log(`complete bytes=${file.size}`);
  return status.complete ? status : sourceStatusWithRetry(projectId, clipId);
}

async function ensureRemoteClip(
  projectId: string,
  clip: ClipInfo,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/clips/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: clip.id, name: clip.name }),
  });
  if (res.status === 404) {
    // Server copy of the project is gone — see syncData's 404 handling.
    patchActiveProject(projectId, {
      saveState: "error",
      saveError:
        "The server copy of this project was deleted. Your edits remain saved on this device only.",
      serverProjectReady: false,
      serverConflict: true,
    });
    throw new DOMException("Project deleted on server", "AbortError");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Clip creation failed (${res.status})`);
  }
}

async function ensureServerProject(): Promise<void> {
  if (creatingProject) return creatingProject;
  const start = useStudio.getState();
  if (!start.projectId || start.serverProjectReady || start.clips.length === 0)
    return;
  // A project the server deleted (or that conflicted) must never be silently
  // recreated from the local recovery copy.
  if (start.serverConflict) return;
  const projectId = start.projectId;
  const clipIds = start.clips.map((clip) => clip.id);
  creatingProject = (async () => {
    // Yield BEFORE any setState: the creatingProject assignment only
    // completes once this async body first suspends. A synchronous setState
    // here would re-enter the persistence subscriber with the guard still
    // unset, calling ensureServerProject again — infinite recursion.
    await Promise.resolve();
    useStudio.setState({ saveState: "saving", saveError: null });
    try {
      const res = await fetch(`/api/projects/${projectId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: start.fileName,
          clips: start.clips.map((clip) => ({ id: clip.id, name: clip.name })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (
        !res.ok ||
        body?.id !== projectId ||
        !Number.isSafeInteger(body?.revision)
      ) {
        throw new Error(
          body?.error || `Project creation failed (${res.status})`,
        );
      }
      const current = useStudio.getState();
      const stillCurrent =
        current.projectId === projectId &&
        current.clips.length === clipIds.length &&
        current.clips.every((clip, index) => clip.id === clipIds[index]);
      if (!stillCurrent) return;
      serverRevisions.set(projectId, body.revision);
      useStudio.setState({
        serverProjectReady: true,
        serverRevision: body.revision,
        serverConflict: false,
      });
      await saveData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useStudio.setState({ saveState: "error", saveError: message });
    }
  })().finally(() => {
    creatingProject = null;
  });
  return creatingProject;
}

const clipGone = (clipId: string) =>
  !useStudio.getState().clips.some((c) => c.id === clipId);

/** Server-side clip delete (also used when an upload finishes orphaned). */
async function deleteClipRemote(
  projectId: string,
  clipId: string,
): Promise<void> {
  await fetch(`/api/projects/${projectId}/clips/${clipId}`, {
    method: "DELETE",
  }).catch(() => {});
}

async function uploadClip(clipId: string): Promise<void> {
  const s = useStudio.getState();
  const clip = s.clips.find((c) => c.id === clipId);
  const slot = getClipSnapshot(clipId);
  if (!clip || !slot?.file) return;
  if (!s.serverProjectReady) return;
  if (clip.uploadState !== "local" && clip.uploadState !== "error") return;
  const file = slot.file;
  patchClip(clipId, {
    uploadState: "uploading",
    uploadError: null,
  });
  console.log(
    `[cap-upload] clip=${clipId} begin bytes=${file.size} serverProjectReady=${s.serverProjectReady}`,
  );
  try {
    const projectId = s.projectId;
    if (!projectId) throw new Error("Project is still being created");
    await ensureRemoteClip(projectId, clip);
    let resp: UploadResp | null = null;
    try {
      resp = await uploadOriginalToObjectStorage(projectId, clipId, file);
    } catch (error) {
      // Keep export functional during rollout or a bucket/CORS outage. The
      // resumable app-server route is slower, but it never discards the work.
      console.warn(
        "[cap-upload] direct object upload unavailable; using app-server fallback:",
        error instanceof Error ? error.message : error,
      );
    }
    resp ??= await (async () => {
      try {
        const parallel = await uploadOriginalParallel(projectId, clipId, file);
        if (parallel) return parallel;
      } catch (error) {
        if (!(error instanceof ParallelUnavailable)) throw error;
      }
      return uploadOriginalResumable(projectId, clipId, file);
    })();
    if (clipGone(clipId)) {
      await deleteClipRemote(projectId, clipId);
      return;
    }
    console.log(`[cap-upload] clip=${clipId} source stored, awaiting proxy`);
    patchClip(clipId, {
      uploadState: "done",
      uploadPct: 100,
      hasOriginal: true,
      originalBytes: resp.originalBytes ?? file.size,
    });
    void waitForProxy(projectId, clipId, clip.videoUrl, file.size);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[cap-upload] clip=${clipId} failed:`, msg);
    patchClip(clipId, { uploadState: "error", uploadError: msg });
  }
}

async function waitForProxy(
  projectId: string,
  clipId: string,
  fromUrl: string,
  originalBytes: number,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (clipGone(clipId)) return;
    // asked again when the server says a project changed (its proxy is in), or after 10 s; subscribed before the
    // read, so a proxy finishing meanwhile is not missed
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Promise<void>((resolve) => {
      off = onTopic("projects", () => resolve());
      timer = setTimeout(resolve, 10_000);
    });
    try {
      const status = await sourceStatus(projectId, clipId);
      if (status.proxyReady) {
        applyProbe(clipId, status);
        await switchToProxy(projectId, clipId, fromUrl, originalBytes);
        return;
      }
      await changed;
    } catch {
      // The original is already safe. A transient polling failure must not
      // turn the completed source upload back into a failed project.
      await changed;
    } finally {
      off();
      clearTimeout(timer);
    }
  }
}

/** Probed source metadata from an upload response → clip + live state. */
function applyProbe(clipId: string, resp: UploadResp): void {
  patchClip(clipId, {
    ...(resp.srcWidth
      ? { sourceWidth: resp.srcWidth, sourceHeight: resp.srcHeight ?? 0 }
      : {}),
    ...(resp.srcFps ? { srcFps: resp.srcFps } : {}),
  });
  const s = useStudio.getState();
  if (s.activeClipId === clipId) {
    if (resp.srcWidth) {
      useStudio.setState({
        sourceWidth: resp.srcWidth,
        sourceHeight: resp.srcHeight ?? 0,
      });
    }
    if (resp.srcFps) s.setSrcFps(resp.srcFps, "probe");
  }
}

/** Manual retry after a failed upload (the clip bar's error badge). */
export function retryClipUpload(clipId: string): void {
  patchClip(clipId, { uploadState: "local", uploadError: null });
  queueUpload(clipId);
}

/**
 * Swap a clip's playback from the raw import blob to the server's small
 * editing proxy. Browsers can't decode some sources at all (ProRes/HEVC
 * .mov) and struggle with multi-GB files — the proxy plays everywhere.
 */
async function switchToProxy(
  projectId: string,
  clipId: string,
  fromUrl: string,
  originalBytes: number,
): Promise<void> {
  const s = useStudio.getState();
  const clip = s.clips.find((c) => c.id === clipId);
  if (!clip || clip.videoUrl !== fromUrl) return;
  // Replacing the active <video> source reloads the media element and briefly
  // remeasures the preview. Never do that underneath a processing state: wait
  // for a short, stable idle window so late status transitions cannot make the
  // locked screen flash or jump while the user is watching it.
  if (s.activeClipId === clipId && isEditorBusy(s)) {
    const unsubscribe = useStudio.subscribe((next) => {
      if (isEditorBusy(next)) return;
      unsubscribe();
      window.setTimeout(
        () => void switchToProxy(projectId, clipId, fromUrl, originalBytes),
        250,
      );
    });
    return;
  }
  // Restored projects may have tried this URL before the proxy existed. Give
  // the media element a new URL once processing finishes so it reloads instead
  // of keeping a cached 404/error state.
  const proxyUrl = `/api/projects/${projectId}/clips/${clipId}/video?ready=${Date.now()}`;
  if (fromUrl.startsWith("blob:")) URL.revokeObjectURL(fromUrl);
  // Keep the original File handle for this tab. Local export must remain
  // available even after playback switches to the lightweight server proxy.
  patchClip(clipId, {
    videoUrl: proxyUrl,
    uploadState: "done",
    hasOriginal: true,
    originalBytes,
  });
  if (s.activeClipId === clipId) {
    const t = s.currentTime;
    useStudio.setState({ videoUrl: proxyUrl, importedFile: null });
    useStudio.getState().seek(t);
    // waveform for imports too big to decode client-side — use the proxy
    void useStudio.getState().ensureAudio();
  }
}

export function initPersistence(): void {
  let lastProject: string | null = null;
  let last: {
    w: unknown;
    c: unknown;
    st: unknown;
    ps: unknown;
    tx: unknown;
    n: unknown;
    f: unknown;
    m: unknown;
    a: unknown;
    sc: unknown;
  } | null = null;

  // background clips' transcripts save directly; removed clips delete remotely
  setSaveClipHook((clipId) => void saveClip(clipId));
  setClipRemovedHook((projectId, clipId) => {
    if (clipId) void deleteClipRemote(projectId, clipId);
    else void deleteSession(projectId);
  });
  // a drag-reorder changes no editor state — save the new clip order now
  // (flush first: a pending debounced save still carries the old order
  // and would revert it if it landed after)
  setClipReorderedHook(() => {
    void (async () => {
      await flushPendingSave();
      await saveData();
    })();
  });

  useStudio.subscribe((s) => {
    // The durable project shell is tiny and must exist before media upload.
    // Transcript autosave no longer depends on the source transfer.
    if (s.projectId && !s.serverProjectReady && s.clips.length > 0) {
      void ensureServerProject();
      return;
    }
    // every fresh import becomes a project right away — the server proxy
    // makes it playable (ProRes/HEVC/huge files) and edits autosave even
    // when the user never transcribes
    if (s.serverProjectReady) {
      for (const clip of s.clips) {
        if (clip.uploadState === "local" && getClipSnapshot(clip.id)?.file) {
          queueUpload(clip.id);
        }
      }
    }
    if (!s.projectId || !s.serverProjectReady) return;
    // no saves mid-transcription; idle (untranscribed) and done both save
    if (s.status.phase !== "done" && s.status.phase !== "idle") return;

    if (s.projectId !== lastProject) {
      // A browser-recovery restore can contain edits newer than the server.
      // Push that recovered snapshot immediately instead of waiting for the
      // user to make one more edit before cloud sync resumes.
      lastProject = s.projectId;
      last = {
        w: s.words,
        c: s.cues,
        st: s.style,
        ps: s.posSegments,
        tx: s.texts,
        n: s.fileName,
        f: s.fps,
        m: s.model,
        a: s.autoCadence,
        sc: s.script,
      };
      if (
        s.localSaveState === "saved" &&
        (s.words.length || s.cues.length || s.texts.length)
      ) {
        scheduleSave(s);
      }
      return;
    }
    if (
      last &&
      last.w === s.words &&
      last.c === s.cues &&
      last.st === s.style &&
      last.ps === s.posSegments &&
      last.tx === s.texts &&
      last.n === s.fileName &&
      last.f === s.fps &&
      last.m === s.model &&
      last.a === s.autoCadence &&
      last.sc === s.script
    ) {
      return;
    }
    last = {
      w: s.words,
      c: s.cues,
      st: s.style,
      ps: s.posSegments,
      tx: s.texts,
      n: s.fileName,
      f: s.fps,
      m: s.model,
      a: s.autoCadence,
      sc: s.script,
    };
    scheduleSave(s);
  });
}
