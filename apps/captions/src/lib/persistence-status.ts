import { canMove, type Moves } from "@contracts/transition";

export type ProjectSaveState = "idle" | "saving" | "saved" | "error";
export type ClipUploadState =
  "local" | "uploading" | "processing" | "done" | "error";

/*
 * Caption Studio's three badge states and the moves each makes while one project is open. Every write in store.ts,
 * persist.ts and local-recovery.ts goes through `badge` below. A start is not a move: the store's first state, a
 * project opened, restored, imported or closed, and a new clip begin at whatever they are (`from` null). The tables are
 * built from the writers as they are today; persistence-status.test.ts names the site of every move.
 */

/** `saveState`, the save to the server. Only a start goes back to idle, and idle is never saved without a save. */
export const SERVER_SAVE_MOVES: Moves<ProjectSaveState> = {
  idle: ["saving", "error"],
  saving: ["saved", "error"],
  saved: ["saving", "error"],
  error: ["saving", "saved"],
};

/**
 * `localSaveState`, the copy on this browser's disk. Every move happens: the answer of a write is not matched to the
 * save that asked for it, so it lands on whatever the state has become since.
 */
export const LOCAL_SAVE_MOVES: Moves<ProjectSaveState> = {
  idle: ["saving", "saved", "error"],
  saving: ["idle", "saved", "error"],
  saved: ["idle", "saving", "error"],
  error: ["idle", "saving", "saved"],
};

/**
 * `ClipInfo.uploadState`, one clip's source on its way to the server. An upload starts only from local or error, and
 * nothing writes "processing" (a copy stored by an older version can hold it; a file put back makes it local).
 */
export const CLIP_UPLOAD_MOVES: Moves<ClipUploadState> = {
  local: ["uploading", "done", "error"],
  uploading: ["done", "error", "local"],
  processing: ["local"],
  done: ["local", "error"],
  error: ["uploading", "local", "done"],
};

/**
 * The one writer of the three states. Returns `to`: `saveState: badge(SERVER_SAVE_MOVES, s.saveState, "saving",
 * "scheduleSave")`. `from` null is a start; `site` names the function that asks. A move its table does not list is
 * made all the same and reported, because a badge must never stop a save or stay stuck: a warning in the running app,
 * an error under vitest, so the suites show a table that is short.
 */
export function badge<S extends string>(moves: Moves<S>, from: S | null, to: S, site: string): S {
  if (from !== null && !canMove(moves, from, to)) {
    const message = `Caption Studio badge (${site}): "${from}" → "${to}" is not in its moves table`;
    if (import.meta.env.MODE === "test") throw new Error(message);
    console.warn(message);
  }
  return to;
}

export interface PersistenceClip {
  uploadState: ClipUploadState;
  uploadPct: number;
}

export interface ProjectPersistenceInput {
  projectId: string | null;
  serverProjectReady?: boolean;
  saveState: ProjectSaveState;
  localSaveState?: ProjectSaveState;
  clips: PersistenceClip[];
}

export interface ProjectPersistenceStatus {
  workSafe: boolean;
  fullySaved: boolean;
  tone: "saved" | "saving" | "warning" | "danger";
  badge: string;
  message: string | null;
}

/**
 * Work is safe once the browser recovery record or server edit record exists.
 * Source upload is a separate cloud-render capability, never a prerequisite
 * for preserving the transcript.
 * `saveState === "idle"` alone says nothing about persistence: it is also the
 * initial state of a brand-new, browser-memory-only project.
 */
export function getProjectPersistenceStatus({
  projectId,
  serverProjectReady = !!projectId,
  saveState,
  localSaveState = "idle",
  clips,
}: ProjectPersistenceInput): ProjectPersistenceStatus {
  if (clips.length === 0) {
    return {
      workSafe: true,
      fullySaved: true,
      tone: "saved",
      badge: "NO PROJECT OPEN",
      message: null,
    };
  }

  const locallySaved = localSaveState === "saved";
  // A loaded/saved server project is still safe when the browser refuses an
  // IndexedDB/localStorage write (private mode, quota pressure, etc.). The
  // local source backup and the transcript save are independent guarantees.
  const editsSavedToServer =
    serverProjectReady && (saveState === "idle" || saveState === "saved");

  if (localSaveState === "error" && !editsSavedToServer) {
    return {
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: "NOT SAVED — LOCAL BACKUP FAILED",
      message:
        "Browser recovery storage failed. Keep this page open until the project reaches the server.",
    };
  }

  const failed = clips.filter((clip) => clip.uploadState === "error");
  if (saveState === "error") {
    if (locallySaved) {
      return {
        workSafe: true,
        fullySaved: false,
        tone: "warning",
        badge: "SAVED LOCALLY — CLOUD SYNC FAILED",
        message:
          "Your edits are recoverable on this device. Cloud sync failed and will retry without blocking local work.",
      };
    }
    return {
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: "NOT SAVED — SAVE FAILED",
      message:
        "The latest project changes did not reach the server. Do not close, refresh, switch projects, or deploy.",
    };
  }

  if (failed.length > 0) {
    if (locallySaved || editsSavedToServer) {
      return {
        workSafe: true,
        fullySaved: false,
        tone: "warning",
        badge: serverProjectReady
          ? "PROJECT SAVED — SOURCE UPLOAD FAILED"
          : "SAVED LOCALLY — SOURCE UPLOAD FAILED",
        message:
          "Your transcript and edits are safe. Only cloud video rendering is unavailable; retrying resumes the source upload.",
      };
    }
    return {
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: serverProjectReady
        ? "PARTIALLY SAVED — UPLOAD FAILED"
        : "NOT SAVED — UPLOAD FAILED",
      message:
        "One or more source videos failed to upload. Retry the failed upload before leaving this page.",
    };
  }

  const uploading = clips.filter((clip) => clip.uploadState === "uploading");
  const processing = clips.filter((clip) => clip.uploadState === "processing");
  const local = clips.filter((clip) => clip.uploadState === "local");
  const pendingCount = uploading.length + processing.length + local.length;

  if (!serverProjectReady) {
    const averageUpload = uploading.length
      ? Math.round(
          uploading.reduce((sum, clip) => sum + clip.uploadPct, 0) /
            uploading.length,
        )
      : null;
    const detail = uploading.length
      ? `UPLOADING ${averageUpload}%`
      : processing.length
        ? "SERVER PREPARING VIDEO"
        : local.length
          ? "WAITING TO UPLOAD"
          : "NO SERVER COPY";
    return {
      workSafe: locallySaved,
      fullySaved: false,
      tone: locallySaved ? "warning" : "danger",
      badge: locallySaved
        ? `SAVED LOCALLY — ${detail}`
        : `NOT SAVED — ${detail}`,
      message: locallySaved
        ? "Your edits are recoverable on this device while the project connects to the server."
        : "This project still exists only in this browser tab. Do not close, refresh, switch projects, or deploy until it says SAVED.",
    };
  }

  if (pendingCount > 0) {
    const averageUpload = uploading.length
      ? Math.round(
          uploading.reduce((sum, clip) => sum + clip.uploadPct, 0) /
            uploading.length,
        )
      : null;
    const pendingLabel = uploading.length
      ? `VIDEO UPLOADING ${averageUpload}%`
      : processing.length
        ? "SERVER PREPARING VIDEO"
        : "VIDEO WAITING TO UPLOAD";
    if (locallySaved) {
      return {
        workSafe: true,
        fullySaved: false,
        tone: "warning",
        badge: `EDITS SAVED LOCALLY — ${pendingLabel}`,
        message:
          "Your transcript and edits will restore on this device if you close or refresh. The source upload continues separately for cloud rendering.",
      };
    }
    return {
      workSafe: saveState === "saved",
      fullySaved: false,
      tone: "warning",
      badge: `PARTIALLY SAVED — ${pendingCount} CLIP${pendingCount === 1 ? "" : "S"} PENDING`,
      message:
        saveState === "saved"
          ? "Your transcript is in the cloud project. The source upload is still pending, so cloud video rendering is not ready yet."
          : "The latest edits and source video are still being saved. Keep this page open until the local-save badge appears.",
    };
  }

  if (saveState === "saving") {
    return {
      workSafe: locallySaved,
      fullySaved: false,
      tone: "saving",
      badge: locallySaved ? "SAVED LOCALLY — SYNCING" : "SAVING",
      message: locallySaved
        ? "Your edits are recoverable on this device and are syncing to the server."
        : "Project changes are being written to the server. Keep this page open until the badge says SAVED.",
    };
  }

  return {
    workSafe: true,
    fullySaved: true,
    tone: "saved",
    badge: "SAVED",
    message: null,
  };
}
