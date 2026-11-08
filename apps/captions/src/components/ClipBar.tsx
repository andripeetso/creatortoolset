import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CloudUpload,
  Crown,
  Film,
  Loader2,
  Plus,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import {
  isEditorBusy,
  isMasterApplyReady,
  useStudio,
  type ClipInfo,
} from "@/lib/store";
import { flushPendingSave, retryClipUpload } from "@/lib/persist";
import { fmtClock } from "@/lib/ass";

/**
 * The project's clip pool: one chip per clip with its transcription /
 * upload status. Click to edit that clip; clips can be added to the
 * pool anytime (they inherit the project's settings and transcribe
 * automatically), removed from it, or drag-reordered. The FIRST clip is
 * the master: "Apply master" (bar header) replays what was changed on it
 * onto the other clips, which otherwise keep their own words.
 */

function ClipStatus({ clip, applyCov }: { clip: ClipInfo; applyCov?: number }) {
  // outcome of the last apply-master run merges into the status line —
  // the numbers live in the chip's tooltip, the line stays quiet
  if (applyCov != null && clip.transcribed && clip.uploadState === "done") {
    if (applyCov < 0.3) {
      return (
        <span className="flex items-center gap-1 text-rose-400">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          <span className="truncate">Skipped</span>
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1 text-amber-400">
        <Wand2 className="h-3 w-3 shrink-0" />
        <span className="truncate">Master applied</span>
      </span>
    );
  }
  if (clip.uploadState === "uploading") {
    return (
      <span className="flex items-center gap-1 text-sky-400">
        <CloudUpload className="h-3 w-3 shrink-0 animate-pulse" />
        <span className="truncate">Uploading {clip.uploadPct}%</span>
      </span>
    );
  }
  if (clip.uploadState === "processing") {
    return (
      <span
        className="flex items-center gap-1 text-sky-400"
        title="The server is compressing the uploaded video into a small editing proxy — captions are not affected"
      >
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span className="truncate">Preparing video</span>
      </span>
    );
  }
  if (clip.uploadState === "error") {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          retryClipUpload(clip.id);
        }}
        title={`${clip.uploadError || "Upload failed"} — click to retry`}
        className="flex items-center gap-1 text-amber-400 hover:text-amber-300"
      >
        <TriangleAlert className="h-3 w-3 shrink-0" /> Retry upload
      </button>
    );
  }
  const st = clip.status;
  if (
    st.phase === "extracting" ||
    st.phase === "transcribing" ||
    st.phase === "checking" ||
    st.phase === "matching"
  ) {
    return (
      <span className="flex items-center gap-1 text-violet-400">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        {st.phase === "extracting"
          ? st.detail?.startsWith("Uploading")
            ? "Uploading source"
            : "Preparing audio"
          : st.phase === "matching"
            ? "Matching"
            : st.phase === "checking"
              ? "Checking script"
              : "Transcribing"}
      </span>
    );
  }
  if (st.phase === "loading") {
    return (
      <span className="flex items-center gap-1 text-violet-400">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> Model{" "}
        {st.progress}%
      </span>
    );
  }
  if (st.phase === "error") {
    return (
      <span className="flex items-center gap-1 text-red-400" title={st.message}>
        <TriangleAlert className="h-3 w-3 shrink-0" /> Failed
      </span>
    );
  }
  if (clip.transcribed) {
    return (
      <span className="flex items-center gap-1 text-emerald-500">
        <Check className="h-3 w-3 shrink-0" /> Captioned
      </span>
    );
  }
  return <span className="text-zinc-600">Not transcribed</span>;
}

export function ClipBar() {
  const clips = useStudio((s) => s.clips);
  const activeClipId = useStudio((s) => s.activeClipId);
  const addClips = useStudio((s) => s.addClips);
  const removeClip = useStudio((s) => s.removeClip);
  const moveClip = useStudio((s) => s.moveClip);
  const renameClip = useStudio((s) => s.renameClip);
  const toggleClipDone = useStudio((s) => s.toggleClipDone);
  const applyingMaster = useStudio((s) => s.applyingMaster);
  const applyMasterProgress = useStudio((s) => s.applyMasterProgress);
  const applyMasterToAll = useStudio((s) => s.applyMasterToAll);
  const masterApplyResults = useStudio((s) => s.masterApplyResults);
  const masterApplyInserted = useStudio((s) => s.masterApplyInserted);
  const masterApplyCorrected = useStudio((s) => s.masterApplyCorrected);
  const refiningClipId = useStudio((s) => s.refiningClipId);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const selectedClipIds = useStudio((s) => s.selectedClipIds);
  const setSelectedClipIds = useStudio((s) => s.setSelectedClipIds);
  const selected = new Set(selectedClipIds);
  const setSelected = (s: ReadonlySet<string>) => setSelectedClipIds([...s]);
  const anchorRef = useRef(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // OS file drag over the bar — highlighted until the drop/leave settles;
  // dragenter/leave fire per-child, so a depth counter keeps it stable
  const [fileDrag, setFileDrag] = useState(false);
  const fileDragDepth = useRef(0);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("clipBarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem("clipBarCollapsed", v ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !v;
    });

  if (clips.length === 0) return null;

  const open = async (id: string) => {
    if (id === useStudio.getState().activeClipId) return;
    await flushPendingSave();
    useStudio.getState().switchClip(id);
  };

  const onChipClick = (clip: ClipInfo, i: number, e: React.MouseEvent) => {
    if (e.shiftKey) {
      // range-select from the last plain/cmd-clicked chip
      const a = Math.min(anchorRef.current, i);
      const b = Math.max(anchorRef.current, i);
      setSelected(new Set(clips.slice(a, b + 1).map((c) => c.id)));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(clip.id, i);
      return;
    }
    // a plain click OPENS the clip and makes it the selection — what you
    // clicked is what apply/export acts on; ⌘ toggles more in, the
    // header ✕ clears back to "all"
    anchorRef.current = i;
    setSelected(new Set([clip.id]));
    void open(clip.id);
  };

  const toggleSelect = (id: string, i: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    anchorRef.current = i;
  };

  // clips the apply-master run would target right now
  const masterReady = isMasterApplyReady(clips[0]);
  const scope = clips
    .slice(1)
    .filter((c) => !selected.size || selected.has(c.id));
  const pendingCount = scope.filter(
    (c) => isEditorBusy({ status: c.status, refining: false }),
  ).length;
  const readyCount = scope.filter(isMasterApplyReady).length;
  const canApplyMaster = clips.length > 1 && masterReady && scope.length > 0;
  const applyDisabled =
    applyingMaster || !!refiningClipId || pendingCount > 0 || readyCount === 0;
  const selectedCount = clips.filter((c) => selected.has(c.id)).length;

  const onDrop = (to: number) => (e: React.DragEvent) => {
    // OS files bubble up to the bar's own drop handler instead
    if (e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDropAt(null);
    const from = Number(e.dataTransfer.getData("application/x-clip-index"));
    if (Number.isInteger(from)) moveClip(from, to);
  };

  const onFileDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    fileDragDepth.current += 1;
    setFileDrag(true);
  };
  const onFileDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onFileDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    fileDragDepth.current -= 1;
    if (fileDragDepth.current <= 0) {
      fileDragDepth.current = 0;
      setFileDrag(false);
    }
  };
  const onFileDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    fileDragDepth.current = 0;
    setFileDrag(false);
    setDropAt(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) addClips(files);
  };
  const fileDropHandlers = {
    onDragEnter: onFileDragEnter,
    onDragOver: onFileDragOver,
    onDragLeave: onFileDragLeave,
    onDrop: onFileDrop,
  };

  if (collapsed) {
    const busy = clips.filter(
      (c) =>
        c.uploadState === "uploading" ||
        c.uploadState === "processing" ||
        c.status.phase === "extracting" ||
        c.status.phase === "transcribing" ||
        c.status.phase === "checking" ||
        c.status.phase === "matching" ||
        c.status.phase === "loading",
    ).length;
    const doneCount = clips.filter((c) => c.done).length;
    return (
      <button
        {...fileDropHandlers}
        onClick={toggleCollapsed}
        title="Show the clip bar"
        className={`flex w-full items-center gap-2 border-t border-dashed bg-zinc-925 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
          fileDrag
            ? "border-sky-400/70 text-sky-300 ring-2 ring-inset ring-sky-400/40"
            : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
        }`}
      >
        <ChevronUp className="h-3 w-3" />
        <Film className="h-3 w-3" /> Clips · {clips.length}
        <span className="flex items-center gap-1 normal-case tracking-normal text-amber-400/80">
          <Crown className="h-2.5 w-2.5" />
          <span className="max-w-48 truncate">{clips[0]?.name}</span>
        </span>
        {busy > 0 && (
          <span className="flex items-center gap-1 normal-case tracking-normal text-sky-400">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> {busy} working
          </span>
        )}
        {applyingMaster && (
          <span className="flex items-center gap-1 normal-case tracking-normal text-amber-300">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> Applying master
            {applyMasterProgress &&
              ` ${applyMasterProgress.done}/${applyMasterProgress.total}`}
            …
          </span>
        )}
        {doneCount > 0 && (
          <span className="flex items-center gap-1 normal-case tracking-normal text-emerald-400/80">
            <Check className="h-2.5 w-2.5" /> {doneCount} done
          </span>
        )}
        <span className="flex-1" />
        <span className="rounded border border-zinc-700 px-1.5 py-px text-[9px] text-zinc-400">
          Show
        </span>
      </button>
    );
  }

  return (
    <div
      {...fileDropHandlers}
      className={`border-t bg-zinc-925 ${
        fileDrag
          ? "border-sky-400/70 ring-2 ring-inset ring-sky-400/40"
          : "border-zinc-800"
      }`}
    >
      {/* pool header: clip count + pool-level actions */}
      <div className="flex items-center gap-2 px-3 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        <button
          onClick={toggleCollapsed}
          title="Hide the clip bar"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        <Film className="h-3 w-3" /> Clips · {clips.length}
        {selectedCount > 0 && (
          <button
            onClick={() => setSelected(new Set())}
            title="Clear selection"
            className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300 normal-case tracking-normal hover:bg-sky-500/25"
          >
            {selectedCount} selected <X className="h-2.5 w-2.5" />
          </button>
        )}
        <div className="flex-1" />
        {canApplyMaster && (
          <button
            onClick={() =>
              void applyMasterToAll(
                // only ids that still exist — a stale selection must
                // never fall back to "all"
                selectedCount > 0
                  ? clips.filter((c) => selected.has(c.id)).map((c) => c.id)
                  : undefined,
              )
            }
            disabled={applyDisabled}
            title={
              pendingCount > 0
                ? `Wait — ${pendingCount} clip${pendingCount > 1 ? "s are" : " is"} still transcribing or matching captions`
                : readyCount === 0
                  ? "No captioned clips to apply to yet"
                  : selectedCount > 0
                    ? "Apply what you changed on the master (first) clip to the selected clips: its word fixes where they say the same words, its caption breaks where they share words. Their own wording stays."
                    : "Apply what you changed on the master (first) clip to every transcribed clip: its word fixes where they say the same words, its caption breaks where they share words. Their own wording stays."
            }
            className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-300 transition-colors hover:border-amber-400 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applyingMaster ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {applyMasterProgress && applyMasterProgress.total > 1
                  ? `Applying ${applyMasterProgress.done}/${applyMasterProgress.total}…`
                  : "Applying…"}
              </>
            ) : (
              <>
                <Wand2 className="h-3 w-3" />
                {selectedCount > 0
                  ? `Apply master to ${selectedCount} selected`
                  : "Apply master to all"}
              </>
            )}
          </button>
        )}
      </div>

      {/* chips */}
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
        {clips.map((clip, i) => {
          const active = clip.id === activeClipId;
          const master = i === 0;
          const isSelected = selected.has(clip.id);
          const applyCov = master ? undefined : masterApplyResults?.[clip.id];
          const skipped = applyCov != null && applyCov < 0.3;
          return (
            <div
              key={clip.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-clip-index", String(i));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer.types.includes("Files")) {
                  e.dataTransfer.dropEffect = "copy";
                  return;
                }
                e.dataTransfer.dropEffect = "move";
                if (dropAt !== i) setDropAt(i);
              }}
              onDragLeave={() => {
                if (dropAt === i) setDropAt(null);
              }}
              onDrop={onDrop(i)}
              onDragEnd={() => setDropAt(null)}
              onClick={(e) => onChipClick(clip, i, e)}
              title={
                master
                  ? `${clip.name} — master clip: its transcript & cadence are the reference for the pool`
                  : skipped
                    ? `${clip.name} — skipped by apply-master: only ${Math.round(applyCov * 100)}% of its words match the master (different video?)`
                    : applyCov != null
                      ? `${clip.name} — master applied: ${Math.round(applyCov * 100)}% match${masterApplyInserted?.[clip.id] ? `, ${masterApplyInserted[clip.id]} words added` : ""}${masterApplyCorrected?.[clip.id] ? `, ${masterApplyCorrected[clip.id]} words corrected` : ""}`
                      : `${clip.name} — shift-click to select a range, ⌘-click to toggle`
              }
              className={`group flex w-auto min-w-44 max-w-80 shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
                dropAt === i ? "border-l-2 border-l-sky-400" : ""
              } ${
                active
                  ? "border-violet-500 bg-violet-500/10"
                  : isSelected
                    ? "border-sky-500/70 bg-sky-500/10 hover:border-sky-400"
                    : master
                      ? "border-amber-500/60 bg-amber-500/5 hover:border-amber-400"
                      : skipped
                        ? "border-rose-500/50 bg-rose-500/5 hover:border-rose-400"
                        : clip.done
                          ? "border-emerald-500/40 bg-emerald-500/5 hover:border-emerald-400"
                          : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 hover:bg-zinc-900"
              }`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSelect(clip.id, i);
                }}
                title={
                  isSelected
                    ? "Remove from selection"
                    : "Select for apply-master (shift-click = range, ⌘-click = toggle)"
                }
                className="relative h-3.5 w-3.5 shrink-0"
              >
                {isSelected ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />
                ) : (
                  <>
                    <Film
                      className={`absolute inset-0 h-3.5 w-3.5 ${
                        selected.size > 0 ? "hidden" : "group-hover:hidden"
                      } ${
                        active
                          ? "text-violet-400"
                          : master
                            ? "text-amber-400"
                            : "text-zinc-500"
                      }`}
                    />
                    <Circle
                      className={`absolute inset-0 h-3.5 w-3.5 text-zinc-600 hover:text-sky-400 ${
                        selected.size > 0 ? "" : "hidden group-hover:block"
                      }`}
                    />
                  </>
                )}
              </button>
              <div
                className={`min-w-0 flex-1 ${clip.done ? "opacity-60" : ""}`}
              >
                <p className="flex items-center gap-1 text-[11px] font-medium text-zinc-200">
                  {renaming === clip.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          renameClip(clip.id, draft);
                          setRenaming(null);
                        } else if (e.key === "Escape") {
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => {
                        renameClip(clip.id, draft);
                        setRenaming(null);
                      }}
                      className="w-full min-w-24 rounded border border-violet-500/60 bg-zinc-950 px-1 py-px text-[11px] font-medium text-zinc-100 outline-none"
                    />
                  ) : (
                    <span
                      className="truncate"
                      title={`${clip.name} — double-click to rename`}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setDraft(clip.name);
                        setRenaming(clip.id);
                      }}
                    >
                      {clip.name}
                    </span>
                  )}
                  {master && (
                    <Crown className="h-3 w-3 shrink-0 text-amber-400" />
                  )}
                </p>
                <div className="truncate text-[10px]">
                  <ClipStatus clip={clip} applyCov={applyCov} />
                </div>
              </div>
              <span className="shrink-0 text-[10px] text-zinc-600">
                {clip.duration > 0 ? fmtClock(clip.duration) : ""}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleClipDone(clip.id);
                }}
                title={clip.done ? "Mark as not done" : "Mark as done"}
                className={`shrink-0 rounded p-0.5 transition-opacity hover:bg-zinc-800 ${
                  clip.done
                    ? "text-emerald-400"
                    : "text-zinc-600 opacity-0 hover:text-emerald-400 group-hover:opacity-100"
                }`}
              >
                <Check className="h-3 w-3" />
              </button>
              {clips.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeClip(clip.id);
                  }}
                  title="Remove from project"
                  className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        <label
          title="Add video files to the pool — or drop them anywhere on this bar"
          className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] transition-colors ${
            fileDrag
              ? "border-sky-400 text-sky-300"
              : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          }`}
        >
          <Plus className="h-3.5 w-3.5" /> Add clips
          <input
            type="file"
            multiple
            accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) addClips(files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
