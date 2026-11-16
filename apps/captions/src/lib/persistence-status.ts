export type ProjectSaveState = "idle" | "saving" | "saved" | "error";
export type ClipUploadState =
  "local" | "uploading" | "processing" | "done" | "error";

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
      badge: "Not saved · local copy failed",
      message:
        "The local copy could not be written, so keep this page open until the project is on the server",
    };
  }

  const failed = clips.filter((clip) => clip.uploadState === "error");
  if (saveState === "error") {
    if (locallySaved) {
      return {
        workSafe: true,
        fullySaved: false,
        tone: "warning",
        badge: "Saved locally · not saved to the server",
        message:
          "The edits are in the local copy, and saving to the server is retried",
      };
    }
    return {
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: "Not saved · save failed",
      message:
        "The latest changes are not on the server, so keep this page open",
    };
  }

  if (failed.length > 0) {
    if (locallySaved || editsSavedToServer) {
      return {
        workSafe: true,
        fullySaved: false,
        tone: "warning",
        badge: serverProjectReady
          ? "Saved · source video upload failed"
          : "Saved locally · source video upload failed",
        message:
          "The transcript and edits are saved; export on the server needs the source video upload retried",
      };
    }
    return {
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: serverProjectReady
        ? "Partly saved · source video upload failed"
        : "Not saved · source video upload failed",
      message:
        "A source video did not upload; retry the upload before leaving this page",
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
      ? `uploading ${averageUpload}%`
      : processing.length
        ? "preparing video"
        : local.length
          ? "waiting to upload"
          : "not on the server";
    return {
      workSafe: locallySaved,
      fullySaved: false,
      tone: locallySaved ? "warning" : "danger",
      badge: locallySaved
        ? `Saved locally · ${detail}`
        : `Not saved · ${detail}`,
      message: locallySaved
        ? "The edits are in the local copy until the project is on the server"
        : "The project is only in this tab, so keep it open until the badge says Saved",
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
      ? `source video uploading ${averageUpload}%`
      : processing.length
        ? "preparing video"
        : "source video waiting to upload";
    if (locallySaved) {
      return {
        workSafe: true,
        fullySaved: false,
        tone: "warning",
        badge: `Edits saved locally · ${pendingLabel}`,
        message:
          "The transcript and edits are in the local copy while the source video uploads",
      };
    }
    return {
      workSafe: saveState === "saved",
      fullySaved: false,
      tone: "warning",
      badge: `Partly saved · ${pendingCount} clip${pendingCount === 1 ? "" : "s"} pending`,
      message:
        saveState === "saved"
          ? "The transcript is on the server; export on the server waits for the source video"
          : "The latest edits and the source video are still being saved, so keep this page open",
    };
  }

  if (saveState === "saving") {
    return {
      workSafe: locallySaved,
      fullySaved: false,
      tone: "saving",
      badge: locallySaved ? "Saved locally · saving to the server" : "Saving",
      message: locallySaved
        ? "The edits are in the local copy and are being saved to the server"
        : "The changes are being saved to the server, so keep this page open until the badge says Saved",
    };
  }

  return {
    workSafe: true,
    fullySaved: true,
    tone: "saved",
    badge: "Saved",
    message: null,
  };
}
