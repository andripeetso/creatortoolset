import { useEffect, useRef, useState } from "react";
import { Loader2, Settings2, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { useStudio } from "@/lib/store";
import { deleteSession } from "@/lib/persist";
import { fmtClock } from "@/lib/ass";
import { EnginePicker } from "./EnginePicker";
import { FpsSelect } from "./FpsSelect";

/**
 * Everything set during project setup, editable later: name, frame
 * rate, transcription engine (with a guarded re-transcribe), plus
 * server-side housekeeping — the stored source file and deleting the
 * project. Server sections hide for guests / not-yet-saved projects.
 */
export function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  const fileName = useStudio((s) => s.fileName);
  const projectId = useStudio((s) => s.projectId);
  const duration = useStudio((s) => s.duration);
  const sourceWidth = useStudio((s) => s.sourceWidth || s.videoWidth);
  const sourceHeight = useStudio((s) => s.sourceHeight || s.videoHeight);
  const status = useStudio((s) => s.status);

  const [name, setName] = useState(fileName);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [original, setOriginal] = useState<{ has: boolean; bytes: number } | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // is the source file still on the server? (drives the storage section)
  const activeClipId = useStudio((s) => s.activeClipId);
  useEffect(() => {
    if (!projectId || !activeClipId) return;
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((p) => {
        const cm = (p.clips ?? []).find(
          (x: { id?: string; hasOriginal?: boolean; originalBytes?: number }) =>
            x.id === activeClipId
        );
        setOriginal({ has: !!cm?.hasOriginal, bytes: cm?.originalBytes ?? 0 });
      })
      .catch(() => {});
  }, [projectId, activeClipId]);

  const close = () => {
    useStudio.getState().setFileName(name);
    onClose();
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const attachOriginal = async (f: File) => {
    if (!projectId || !activeClipId) return;
    setAttaching(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/clips/${activeClipId}/original`,
        { method: "POST", body: f }
      );
      if (!res.ok) throw new Error("Upload failed");
      const j = await res.json();
      const bytes = j.originalBytes ?? f.size;
      setOriginal({ has: true, bytes });
      // keep the clip bar / export dialog in sync
      useStudio.setState((s) => ({
        clips: s.clips.map((c) =>
          c.id === activeClipId
            ? { ...c, hasOriginal: true, originalBytes: bytes }
            : c
        ),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  };

  const removeOriginal = async () => {
    if (!projectId || !activeClipId) return;
    await fetch(
      `/api/projects/${projectId}/clips/${activeClipId}/original`,
      { method: "DELETE" }
    ).catch(() => {});
    setOriginal({ has: false, bytes: 0 });
    useStudio.setState((s) => ({
      clips: s.clips.map((c) =>
        c.id === activeClipId ? { ...c, hasOriginal: false, originalBytes: 0 } : c
      ),
    }));
  };

  const deleteProject = async () => {
    if (!projectId) return;
    setDeleting(true);
    await deleteSession(projectId).catch(() => {});
    useStudio.getState().reset(); // back to the import screen
    onClose(); // Home keeps the open-flag; clear it for the next project
  };

  const label = "mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-[460px] max-w-[92vw] overflow-y-auto rounded-2xl border border-zinc-700 bg-[#16161c] p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Settings2 className="h-4 w-4 text-violet-400" /> Project settings
          </h2>
          <button
            onClick={close}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className={label}>Project name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") close();
          }}
          maxLength={120}
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
        />

        <label className={label}>Video</label>
        <div className="mb-4 flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs">
          <span className="text-zinc-400">
            {duration > 0 ? fmtClock(duration) : "—"}
            {" · "}
            {sourceWidth > 0 ? `${sourceWidth}×${sourceHeight}` : "—"}
          </span>
          <label className="flex items-center gap-2 text-zinc-400">
            FPS
            <FpsSelect className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none" />
          </label>
        </div>

        <label className={label}>Caption engine</label>
        <div className="mb-1 flex items-center gap-2">
          <EnginePicker className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500" />
        </div>
        <p className="mb-3 mt-1 text-[11px] text-zinc-600">
          Used for new transcriptions. To redo a clip, use Re-transcribe in
          the transcript panel.
        </p>
        {status.phase === "error" && (
          <p className="mb-3 mt-1 text-[11px] text-red-400">{status.message}</p>
        )}

        {projectId && (
          <>
            <label className={`${label} mt-4`}>Source file on server</label>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs">
              {original === null ? (
                <span className="text-zinc-500">Checking…</span>
              ) : original.has ? (
                <span className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">
                    Stored for full-quality export{" "}
                    <span className="text-zinc-500">
                      ({(original.bytes / 1e6).toFixed(original.bytes < 10e6 ? 1 : 0)} MB)
                    </span>
                  </span>
                  <button
                    onClick={removeOriginal}
                    title="Delete the source from the server — captions stay editable, re-attach anytime"
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" /> Free up space
                  </button>
                </span>
              ) : (
                <span className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">
                    Not on the server — attach it to enable burned-in export.
                  </span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800">
                    {attaching ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
                      </>
                    ) : (
                      <>
                        <Upload className="h-3 w-3" /> Attach video
                      </>
                    )}
                    <input
                      type="file"
                      accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
                      className="hidden"
                      disabled={attaching}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) attachOriginal(f);
                      }}
                    />
                  </label>
                </span>
              )}
            </div>
            {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}

            <div className="mt-5 border-t border-zinc-800 pt-4">
              {confirmDelete ? (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
                  <p className="mb-2">
                    Delete this project? The video, transcript and captions are
                    removed from the server. This can't be undone.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={deleteProject}
                      disabled={deleting}
                      className="flex items-center gap-1.5 rounded bg-red-500/20 px-2.5 py-1 font-medium hover:bg-red-500/30 disabled:opacity-50"
                    >
                      {deleting && <Loader2 className="h-3 w-3 animate-spin" />}
                      Delete project
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="rounded px-2.5 py-1 text-zinc-400 hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 rounded-md border border-red-500/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                >
                  <TriangleAlert className="h-3.5 w-3.5" /> Delete project…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
