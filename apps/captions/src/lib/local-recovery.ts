import {
  bumpPosIdCounter,
  bumpTextIdCounter,
  clearEditHistory,
  getClipSnapshot,
  loadClipSlots,
  useStudio,
  type ClipInfo,
  type ClipSnapshot,
} from "./store";
import { bumpCueIdCounter } from "./captions";
import type { CaptionStyle, Cue, PosSegment, TextOverlay, Word } from "./types";

const STORAGE_KEY = "caption-studio-emergency-project-v1";
const DB_NAME = "caption-studio-recovery";
const FILE_STORE = "source-files";
const PROJECT_STORE = "projects";
const META_STORE = "meta";
const OPFS_DIR = "caption-studio-source-files";
const ACTIVE_PROJECT_KEY = "active-project-id";
const VERSION = 2;

interface RecoverySlot {
  words: Word[];
  cues: Cue[];
  originalWords: Word[] | null;
  style: CaptionStyle;
  posSegments: PosSegment[];
  texts: TextOverlay[];
  cadenceApplied: boolean;
  cadenceFit: ClipSnapshot["cadenceFit"];
  cadenceDirty: boolean;
  done: boolean;
}

interface RecoveryClip {
  info: Omit<ClipInfo, "videoUrl" | "status">;
  slot: RecoverySlot;
}

export interface RecoveryProject {
  version: number;
  updatedAt: number;
  projectId: string;
  serverProjectReady: boolean;
  serverRevision: number;
  serverConflict: boolean;
  fileName: string;
  activeClipId: string;
  fps: number;
  srcFps: number | null;
  fpsManual: boolean;
  model: string;
  autoCadence: boolean;
  /** Absent in snapshots saved before the script check existed. */
  script?: string;
  setupPending: boolean;
  clips: RecoveryClip[];
}

type StudioSnapshot = ReturnType<typeof useStudio.getState>;

function activeSlot(state: StudioSnapshot): RecoverySlot {
  const stored = state.activeClipId
    ? getClipSnapshot(state.activeClipId)
    : null;
  return {
    words: state.words,
    cues: state.cues,
    originalWords: stored?.originalWords ?? null,
    style: state.style,
    posSegments: state.posSegments,
    texts: state.texts,
    cadenceApplied: state.cadenceApplied,
    cadenceFit: state.cadenceFit,
    cadenceDirty: state.cadenceDirty,
    done: state.done,
  };
}

function storedSlot(slot: ClipSnapshot): RecoverySlot {
  return {
    words: slot.words,
    cues: slot.cues,
    originalWords: slot.originalWords,
    style: slot.style,
    posSegments: slot.posSegments,
    texts: slot.texts,
    cadenceApplied: slot.cadenceApplied,
    cadenceFit: slot.cadenceFit,
    cadenceDirty: slot.cadenceDirty,
    done: slot.done,
  };
}

export function buildRecoveryProject(
  state: StudioSnapshot,
): RecoveryProject | null {
  if (!state.projectId || !state.activeClipId || state.clips.length === 0)
    return null;
  const active = activeSlot(state);
  const clips: RecoveryClip[] = [];
  for (const clip of state.clips) {
    const slot =
      clip.id === state.activeClipId
        ? active
        : (() => {
            const value = getClipSnapshot(clip.id);
            return value ? storedSlot(value) : null;
          })();
    if (!slot) continue;
    const { videoUrl: _videoUrl, status: _status, ...info } = clip;
    void _videoUrl;
    void _status;
    clips.push({ info, slot });
  }
  if (!clips.length) return null;
  return {
    version: VERSION,
    updatedAt: Date.now(),
    projectId: state.projectId,
    serverProjectReady: state.serverProjectReady,
    serverRevision: state.serverRevision,
    serverConflict: state.serverConflict,
    fileName: state.fileName,
    activeClipId: state.activeClipId,
    fps: state.fps,
    srcFps: state.srcFps,
    fpsManual: state.fpsManual,
    model: state.model,
    autoCadence: state.autoCadence,
    script: state.script,
    setupPending: state.setupPending,
    clips,
  };
}

function openRecoveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FILE_STORE)) {
        request.result.createObjectStore(FILE_STORE);
      }
      if (!request.result.objectStoreNames.contains(PROJECT_STORE)) {
        request.result.createObjectStore(PROJECT_STORE);
      }
      if (!request.result.objectStoreNames.contains(META_STORE)) {
        request.result.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB failed"));
  });
}

const newLocalProjectId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function normalizeRecoveryProject(value: unknown): RecoveryProject | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<RecoveryProject> & { projectId?: unknown };
  if (
    !raw.activeClipId ||
    !Array.isArray(raw.clips) ||
    raw.clips.length === 0 ||
    typeof raw.fileName !== "string"
  ) {
    return null;
  }
  const existingProjectId =
    typeof raw.projectId === "string" && raw.projectId ? raw.projectId : null;
  return {
    ...(raw as RecoveryProject),
    version: VERSION,
    projectId: existingProjectId ?? newLocalProjectId(),
    serverProjectReady:
      raw.serverProjectReady ?? (raw.version === 1 && !!existingProjectId),
    serverRevision: Number.isSafeInteger(raw.serverRevision)
      ? raw.serverRevision!
      : 0,
    serverConflict: raw.serverConflict ?? false,
  };
}

async function putRecoveryProject(project: RecoveryProject): Promise<void> {
  const db = await openRecoveryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PROJECT_STORE, META_STORE], "readwrite");
    tx.objectStore(PROJECT_STORE).put(project, project.projectId);
    tx.objectStore(META_STORE).put(project.projectId, ACTIVE_PROJECT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Project backup failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Project backup aborted"));
  });
  db.close();
}

async function getRecoveryProject(id: string): Promise<RecoveryProject | null> {
  const db = await openRecoveryDb();
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readonly");
    const request = tx.objectStore(PROJECT_STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Project restore failed"));
  });
  db.close();
  return normalizeRecoveryProject(value);
}

async function getActiveRecoveryProject(): Promise<RecoveryProject | null> {
  const db = await openRecoveryDb();
  const id = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const request = tx.objectStore(META_STORE).get(ACTIVE_PROJECT_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Active project restore failed"));
  });
  db.close();
  return typeof id === "string" ? getRecoveryProject(id) : null;
}

export interface LocalRecoveryMeta {
  id: string;
  name: string;
  updatedAt: number;
  duration: number;
  clipCount: number;
  thumbClipId: string | null;
  serverProjectReady: boolean;
  serverConflict: boolean;
}

export async function listLocalRecoveryProjects(): Promise<
  LocalRecoveryMeta[]
> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openRecoveryDb();
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readonly");
    const request = tx.objectStore(PROJECT_STORE).getAll();
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () =>
      reject(request.error ?? new Error("Local project list failed"));
  });
  db.close();
  return values
    .map(normalizeRecoveryProject)
    .filter((project): project is RecoveryProject => !!project)
    .map((project) => ({
      id: project.projectId,
      name: project.fileName,
      updatedAt: project.updatedAt,
      duration: project.clips.reduce(
        (total, clip) => total + (clip.info.duration || 0),
        0,
      ),
      clipCount: project.clips.length,
      thumbClipId: project.clips[0]?.info.id ?? null,
      serverProjectReady: project.serverProjectReady,
      serverConflict: project.serverConflict,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function opfsDirectory(
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const manager = navigator.storage;
  if (typeof manager?.getDirectory !== "function") return null;
  const root = await manager.getDirectory();
  try {
    return await root.getDirectoryHandle(OPFS_DIR, { create });
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

async function putSourceFileInOpfs(
  clipId: string,
  file: File,
): Promise<boolean> {
  const dir = await opfsDirectory(true);
  if (!dir) return false;
  const handle = await dir.getFileHandle(clipId, { create: true });
  const writable = await handle.createWritable();
  try {
    await file.stream().pipeTo(writable);
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  return true;
}

async function getSourceFileFromOpfs(clipId: string): Promise<File | null> {
  const dir = await opfsDirectory(false);
  if (!dir) return null;
  try {
    return await (await dir.getFileHandle(clipId)).getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

async function deleteSourceFileFromOpfs(clipId: string): Promise<void> {
  const dir = await opfsDirectory(false);
  if (!dir) return;
  await dir.removeEntry(clipId).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  });
}

async function putSourceFileInIndexedDb(
  clipId: string,
  file: File,
): Promise<void> {
  const db = await openRecoveryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).put(file, clipId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Source backup failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Source backup aborted"));
  });
  db.close();
}

async function getSourceFileFromIndexedDb(clipId: string): Promise<File | null> {
  const db = await openRecoveryDb();
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readonly");
    const request = tx.objectStore(FILE_STORE).get(clipId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Source restore failed"));
  });
  db.close();
  return value instanceof File ? value : null;
}

async function putSourceFile(clipId: string, file: File): Promise<void> {
  if (await putSourceFileInOpfs(clipId, file).catch(() => false)) return;
  await putSourceFileInIndexedDb(clipId, file);
}

async function getSourceFile(clipId: string): Promise<File | null> {
  const opfsFile = await getSourceFileFromOpfs(clipId).catch(() => null);
  return opfsFile ?? getSourceFileFromIndexedDb(clipId);
}

const backedUpFiles = new Map<string, File>();
const sourceBackupJobs = new Map<string, { file: File; job: Promise<void> }>();

function collectSourceFiles(state: StudioSnapshot): [string, File][] {
  return state.clips.flatMap((clip) => {
    const file = getClipSnapshot(clip.id)?.file;
    return file ? [[clip.id, file] as [string, File]] : [];
  });
}

function backUpSourceFiles(files: [string, File][]): void {
  if (typeof indexedDB === "undefined") return;
  for (const [clipId, file] of files) {
    if (backedUpFiles.get(clipId) === file) continue;
    if (sourceBackupJobs.get(clipId)?.file === file) continue;
    const job = putSourceFile(clipId, file)
      .then(() => {
        backedUpFiles.set(clipId, file);
      })
      .catch((error) => {
        console.error("[recovery] source backup failed", error);
      })
      .finally(() => {
        if (sourceBackupJobs.get(clipId)?.job === job) {
          sourceBackupJobs.delete(clipId);
        }
      });
    sourceBackupJobs.set(clipId, { file, job });
  }
}

const localWriteTails = new Map<string, Promise<void>>();

async function persistRecoveryProject(
  state: StudioSnapshot,
  recovery: RecoveryProject,
): Promise<void> {
  const files = collectSourceFiles(state);
  const previous = localWriteTails.get(recovery.projectId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      // Transcript/editor state is tiny and commits first. The much larger
      // media backup is independent and must never delay edit durability.
      await putRecoveryProject(recovery);
      backUpSourceFiles(files);
    });
  localWriteTails.set(recovery.projectId, current);
  await current;
  if (localWriteTails.get(recovery.projectId) === current) {
    localWriteTails.delete(recovery.projectId);
  }
}

async function clearActiveRecoveryProject(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openRecoveryDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).delete(ACTIVE_PROJECT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Local cleanup failed"));
  });
  db.close();
}

let writing = false;

function saveRecoveryNow(): void {
  if (writing) return;
  const state = useStudio.getState();
  const recovery = buildRecoveryProject(state);
  writing = true;
  try {
    if (!recovery) {
      localStorage.removeItem(STORAGE_KEY);
      void clearActiveRecoveryProject().catch(() => {});
      useStudio.setState({
        localSaveState: "idle",
        localSaveError: null,
      });
      return;
    }
    // Best-effort synchronous crash copy. Large projects can exceed the small
    // localStorage quota; IndexedDB below remains the authoritative backup.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recovery));
    } catch {
      /* IndexedDB can still save the complete project. */
    }
    void persistRecoveryProject(state, recovery)
      .then(() => {
        useStudio.setState({
          localSaveState: "saved",
          localSaveError: null,
        });
      })
      .catch((error) => {
        useStudio.setState({
          localSaveState: "error",
          localSaveError:
            error instanceof Error ? error.message : "Source backup failed",
        });
      });
  } catch (error) {
    useStudio.setState({
      localSaveState: "error",
      localSaveError:
        error instanceof Error ? error.message : "Local recovery save failed",
    });
  } finally {
    writing = false;
  }
}

let recoveryTimer: number | null = null;

function scheduleRecoverySave(): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  useStudio.setState({ localSaveState: "saving", localSaveError: null });
  recoveryTimer = window.setTimeout(() => {
    recoveryTimer = null;
    saveRecoveryNow();
  }, 200);
}

function restoreSlot(slot: RecoverySlot, file: File | null): ClipSnapshot {
  return {
    ...slot,
    peaks: null,
    pcm: null,
    file,
  };
}

/**
 * Reconnect retained source files only after the editor snapshot has loaded.
 *
 * A File handle is safe to retain for resumable upload and local export. A
 * blob URL is not safe to mount automatically: doing so asks Chrome to open
 * the original codec immediately and can kill the renderer for large, HEVC,
 * or ProRes sources before the transcript UI appears.
 */
async function attachRecoveredSourceFiles(
  project: RecoveryProject,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const files = new Map<string, File>();
  await Promise.all(
    project.clips.map(async ({ info }) => {
      const file = await getSourceFile(info.id).catch(() => null);
      if (file) files.set(info.id, file);
    }),
  );
  if (!files.size || useStudio.getState().projectId !== project.projectId) {
    return;
  }

  for (const [clipId, file] of files) {
    const slot = getClipSnapshot(clipId);
    if (!slot) continue;
    slot.file = file;
    backedUpFiles.set(clipId, file);
  }

  const state = useStudio.getState();
  if (state.projectId !== project.projectId) return;
  const clips = state.clips.map((clip) => {
    if (!files.has(clip.id) || clip.hasOriginal) return clip;
    return {
      ...clip,
      uploadState: "local" as const,
      uploadError: null,
    };
  });
  // Changing the clip array wakes the persistence subscriber so an incomplete
  // upload resumes. The active importedFile intentionally stays null: export
  // reads the retained slot directly, while playback stays on the proxy URL.
  useStudio.setState({ clips });
}

async function restoreRecoveryProject(
  project: RecoveryProject,
): Promise<boolean> {
  if (
    !project.activeClipId ||
    !Array.isArray(project.clips) ||
    project.clips.length === 0
  ) {
    return false;
  }
  const clips: ClipInfo[] = project.clips.map(({ info, slot }) => {
    const transcribed = slot.words.length > 0 || slot.cues.length > 0;
    const proxyUrl = `/api/projects/${project.projectId}/clips/${info.id}/video`;
    return {
      ...info,
      // Automatic restore never mounts the retained original. The source File
      // is reattached after startup for upload/export without creating a blob
      // URL, while playback remains on the lightweight server proxy.
      videoUrl: proxyUrl,
      status: { phase: transcribed ? "done" : "idle" },
      transcribed,
      uploadState: info.hasOriginal ? "done" : info.uploadState,
      uploadPct: info.hasOriginal ? 100 : info.uploadPct,
    };
  });
  const entries: [string, ClipSnapshot][] = project.clips.map(
    ({ info, slot }) => [info.id, restoreSlot(slot, null)],
  );
  loadClipSlots(entries);

  let cueMax = 0;
  let posMax = 0;
  let textMax = 0;
  for (const [, slot] of entries) {
    cueMax = slot.cues.reduce((max, cue) => Math.max(max, cue.id + 1), cueMax);
    posMax = slot.posSegments.reduce(
      (max, segment) => Math.max(max, segment.id + 1),
      posMax,
    );
    textMax = slot.texts.reduce(
      (max, text) => Math.max(max, text.id + 1),
      textMax,
    );
  }
  bumpCueIdCounter(cueMax);
  bumpPosIdCounter(posMax);
  bumpTextIdCounter(textMax);
  clearEditHistory();

  const activeIndex = Math.max(
    0,
    clips.findIndex((clip) => clip.id === project.activeClipId),
  );
  const active = clips[activeIndex];
  const activeSlotValue = entries[activeIndex][1];
  useStudio.setState({
    projectId: project.projectId,
    serverProjectReady: project.serverProjectReady,
    serverRevision: project.serverRevision,
    serverConflict: project.serverConflict,
    fileName: project.fileName,
    clips,
    activeClipId: active.id,
    videoUrl: active.videoUrl,
    importedFile: null,
    words: activeSlotValue.words,
    cues: activeSlotValue.cues,
    style: activeSlotValue.style,
    posSegments: activeSlotValue.posSegments,
    texts: activeSlotValue.texts,
    cadenceApplied: activeSlotValue.cadenceApplied,
    cadenceFit: activeSlotValue.cadenceFit,
    cadenceDirty: activeSlotValue.cadenceDirty,
    done: activeSlotValue.done,
    peaks: null,
    pcm: null,
    duration: active.duration,
    sourceWidth: active.sourceWidth,
    sourceHeight: active.sourceHeight,
    videoWidth: active.sourceWidth || 1920,
    videoHeight: active.sourceHeight || 1080,
    srcFps: active.srcFps ?? project.srcFps,
    fps: project.fps,
    fpsManual: project.fpsManual,
    model: project.model,
    autoCadence: project.autoCadence,
    script: project.script ?? "",
    scriptFixes: {},
    scriptCheckError: null,
    status: active.status,
    setupPending: project.setupPending,
    saveState: project.serverConflict
      ? "error"
      : project.serverProjectReady
        ? "saved"
        : "idle",
    saveError: project.serverConflict
      ? "A newer server version exists. This local copy is preserved."
      : null,
    localSaveState: "saved",
    localSaveError: null,
    selectedTextId: null,
    editingTextId: null,
    currentTime: 0,
    playing: false,
    selectedClipIds: [],
  });
  // Let React mount the transcript/editor first. This only reconnects File
  // handles; it never creates a playback URL or decodes the original media.
  window.setTimeout(() => {
    void attachRecoveredSourceFiles(project).catch((error) => {
      console.error("[recovery] source reconnect failed", error);
    });
  }, 0);
  return true;
}

export async function restoreLocalRecoveryProject(
  id: string,
): Promise<boolean> {
  const project = await getRecoveryProject(id);
  if (!project) return false;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  return restoreRecoveryProject(project);
}

export async function renameLocalRecoveryProject(
  id: string,
  name: string,
): Promise<boolean> {
  const project = await getRecoveryProject(id);
  const trimmed = name.trim().slice(0, 120);
  if (!project || !trimmed) return false;
  project.fileName = trimmed;
  project.updatedAt = Date.now();
  await putRecoveryProject(project);
  if (useStudio.getState().projectId === id) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  }
  return true;
}

export async function deleteLocalRecoveryProject(id: string): Promise<void> {
  const project = await getRecoveryProject(id);
  const db = await openRecoveryDb();
  await new Promise<void>((resolve, reject) => {
    const stores = project
      ? [PROJECT_STORE, FILE_STORE, META_STORE]
      : [PROJECT_STORE, META_STORE];
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(PROJECT_STORE).delete(id);
    if (project) {
      for (const clip of project.clips) {
        tx.objectStore(FILE_STORE).delete(clip.info.id);
        backedUpFiles.delete(clip.info.id);
        sourceBackupJobs.delete(clip.info.id);
      }
    }
    const activeRequest = tx.objectStore(META_STORE).get(ACTIVE_PROJECT_KEY);
    activeRequest.onsuccess = () => {
      if (activeRequest.result === id) {
        tx.objectStore(META_STORE).delete(ACTIVE_PROJECT_KEY);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Local delete failed"));
  });
  db.close();
  if (project) {
    await Promise.all(
      project.clips.map(({ info }) =>
        deleteSourceFileFromOpfs(info.id).catch(() => undefined),
      ),
    );
  }
  try {
    const emergency = normalizeRecoveryProject(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
    if (emergency?.projectId === id) localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* malformed emergency entry is handled by init recovery */
  }
}

/** Restore first, then keep a synchronous emergency snapshot after each edit. */
export async function initLocalRecovery(): Promise<boolean> {
  let restored = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const emergency = raw ? normalizeRecoveryProject(JSON.parse(raw)) : null;
    const project = emergency ?? (await getActiveRecoveryProject());
    if (project) {
      restored = await restoreRecoveryProject(project);
      if (restored) localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    }
  } catch (error) {
    console.error("[recovery] restore failed", error);
  }

  let previous = useStudio.getState();
  let previousRecovery = buildRecoveryProject(previous);
  useStudio.subscribe((state) => {
    if (writing) {
      previous = state;
      return;
    }
    if (
      previousRecovery &&
      previous.projectId &&
      state.projectId !== previous.projectId
    ) {
      // Keep every project, not just the most recently opened one. The
      // previous serialized snapshot was captured while all of its clip slots
      // were still available, before the store switched projects.
      void putRecoveryProject(previousRecovery).catch((error) => {
        console.error("[recovery] previous project backup failed", error);
      });
    }
    // Upload progress ticks replace the clips array every fraction of a
    // second — persisting those would flip the save badge back and forth and
    // churn IndexedDB for nothing. Only meaningful clip transitions and real
    // edits schedule a recovery write.
    const clipsChanged =
      state.clips.length !== previous.clips.length ||
      state.clips.some((clip, index) => {
        const before = previous.clips[index];
        return (
          !before ||
          before.id !== clip.id ||
          before.name !== clip.name ||
          before.transcribed !== clip.transcribed ||
          before.done !== clip.done ||
          before.status.phase !== clip.status.phase ||
          before.uploadState !== clip.uploadState ||
          before.hasOriginal !== clip.hasOriginal
        );
      });
    const changed =
      state.projectId !== previous.projectId ||
      state.serverProjectReady !== previous.serverProjectReady ||
      state.serverRevision !== previous.serverRevision ||
      state.serverConflict !== previous.serverConflict ||
      state.fileName !== previous.fileName ||
      state.fps !== previous.fps ||
      state.model !== previous.model ||
      state.autoCadence !== previous.autoCadence ||
      state.script !== previous.script ||
      state.setupPending !== previous.setupPending ||
      clipsChanged ||
      state.activeClipId !== previous.activeClipId ||
      state.words !== previous.words ||
      state.cues !== previous.cues ||
      state.style !== previous.style ||
      state.posSegments !== previous.posSegments ||
      state.texts !== previous.texts ||
      state.cadenceApplied !== previous.cadenceApplied ||
      state.cadenceFit !== previous.cadenceFit ||
      state.cadenceDirty !== previous.cadenceDirty ||
      state.done !== previous.done;
    previous = state;
    if (changed) {
      previousRecovery = buildRecoveryProject(state);
      scheduleRecoverySave();
    }
  });
  window.addEventListener("beforeunload", saveRecoveryNow);
  void navigator.storage?.persist?.().catch(() => false);
  if (restored) saveRecoveryNow();
  return restored;
}
