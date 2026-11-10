import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import {
  ArrowLeft,
  Captions,
  Clock,
  Film,
  LayoutGrid,
  List,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useStudio } from "@/lib/store";
import { useCachedList } from "@/lib/local-cache";
import { useSteadyList } from "@/lib/steady-list";
import {
  deleteSession,
  listDeletedSessions,
  listSessions,
  loadSession,
  permanentlyDeleteSession,
  renameSession,
  restoreDeletedSession,
  type DeletedSessionMeta,
  type SessionMeta,
} from "@/lib/persist";
import { fmtClock } from "@/lib/ass";
import { confirmDiscardUnsavedProject } from "@/lib/persistence-guard";
import { PersistenceBadge } from "./PersistenceStatus";
import { AppBar, ToolIntro } from "./AppBar";
import { DropZoneText, dropZoneClass } from "./DropZone";

/** Recent projects shown on the import screen; the rest lives in "All projects". */
const RECENT_COUNT = 6;
const TRASH_KEEP_DAYS = 5;
const VIEW_KEY = "cap-projects-view";
type View = "grid" | "list";

/** Clip thumbnail with a film-icon fallback when none exists. */
function SessionThumb({ s, className }: { s: SessionMeta; className: string }) {
  const [err, setErr] = useState(false);
  if (!s.thumbClipId || err) {
    return (
      <div
        className={`flex items-center justify-center bg-zinc-800 ${className}`}
      >
        <Film className="h-5 w-5 text-zinc-600" />
      </div>
    );
  }
  return (
    <img
      src={`/api/projects/${s.id}/clips/${s.thumbClipId}/thumb`}
      alt=""
      loading="lazy"
      onError={() => setErr(true)}
      className={`object-cover ${className}`}
    />
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  const btn = (v: View, Icon: typeof LayoutGrid, title: string) => (
    <button
      onClick={() => onChange(v)}
      title={title}
      className={`rounded p-1 transition-colors ${
        view === v
          ? "bg-zinc-700 text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div className="flex gap-0.5 rounded-md border border-zinc-800 p-0.5">
      {btn("grid", LayoutGrid, "Thumbnail view")}
      {btn("list", List, "List view")}
    </div>
  );
}

interface SessionHandlers {
  opening: string | null;
  renaming: string | null;
  draft: string;
  setDraft: (v: string) => void;
  startRename: (s: SessionMeta) => void;
  cancelRename: () => void;
  commitRename: (id: string) => void;
  open: (id: string) => void;
  remove: (id: string) => void;
}

function ActionButtons({
  s,
  h,
  className,
}: {
  s: SessionMeta;
  h: SessionHandlers;
  className?: string;
}) {
  if (h.opening === s.id) {
    return <span className="text-[11px] text-violet-400">Opening…</span>;
  }
  return (
    <div className={className}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          h.startRename(s);
        }}
        title="Rename project"
        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          h.remove(s.id);
        }}
        title="Delete project"
        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NameOrInput({
  s,
  h,
  className,
}: {
  s: SessionMeta;
  h: SessionHandlers;
  className: string;
}) {
  if (h.renaming !== s.id) {
    return <p className={`truncate ${className}`}>{s.name}</p>;
  }
  return (
    <input
      autoFocus
      value={h.draft}
      onChange={(e) => h.setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => h.commitRename(s.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") h.commitRename(s.id);
        else if (e.key === "Escape") h.cancelRename();
      }}
      maxLength={120}
      className="w-full rounded-md border border-violet-500 bg-zinc-900 px-1.5 py-0.5 text-sm text-zinc-100 outline-none"
    />
  );
}

function MetaLine({ s }: { s: SessionMeta }) {
  return (
    <>
      {new Date(s.updatedAt).toLocaleDateString()}
      {s.clipCount > 1 && <> · {s.clipCount} clips</>}
      {s.duration > 0 && <> · {fmtClock(s.duration)}</>}
    </>
  );
}

function ProjectSafetyBadge({ s }: { s: SessionMeta }) {
  if (s.serverConflict) {
    return (
      <span className="rounded border border-red-400/70 bg-red-500/25 px-1.5 py-0.5 text-[9px] font-black uppercase text-red-100">
        Conflict copy — safe locally
      </span>
    );
  }
  if (s.localOnly) {
    return (
      <span className="rounded border border-amber-300/60 bg-amber-400/20 px-1.5 py-0.5 text-[9px] font-black uppercase text-amber-100">
        Local only — cloud pending
      </span>
    );
  }
  // A normal synced project is also cached locally, but that is an
  // implementation detail—not a recovery warning. Only surface states that
  // require the user's attention.
  return null;
}

function SessionRow({ s, h }: { s: SessionMeta; h: SessionHandlers }) {
  return (
    <div
      onClick={() => h.renaming !== s.id && h.open(s.id)}
      className="group flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-2 transition-colors hover:border-violet-500/50 hover:bg-zinc-900"
    >
      <SessionThumb s={s} className="h-10 w-[72px] shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <NameOrInput s={s} h={h} className="text-sm text-zinc-200" />
        <p className="text-[11px] text-zinc-500">
          <MetaLine s={s} />
        </p>
        <div className="mt-1">
          <ProjectSafetyBadge s={s} />
        </div>
      </div>
      <ActionButtons
        s={s}
        h={h}
        className="flex opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}

function SessionTile({ s, h }: { s: SessionMeta; h: SessionHandlers }) {
  return (
    <div
      onClick={() => h.renaming !== s.id && h.open(s.id)}
      className="group cursor-pointer overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-violet-500/50 hover:bg-zinc-900"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-800">
        <SessionThumb
          s={s}
          className="h-full w-full transition-transform group-hover:scale-[1.03]"
        />
        <ActionButtons
          s={s}
          h={h}
          className="absolute right-1 top-1 flex rounded-md bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
        />
        {s.clipCount > 1 && (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-px text-[9px] font-medium text-zinc-300">
            {s.clipCount} clips
          </span>
        )}
        {h.opening === s.id && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[11px] text-violet-300">
            Opening…
          </div>
        )}
      </div>
      <div className="px-2 py-1.5">
        <NameOrInput
          s={s}
          h={h}
          className="text-xs font-medium text-zinc-200"
        />
        <p className="mt-0.5 truncate text-[10px] text-zinc-500">
          <MetaLine s={s} />
        </p>
        <div className="mt-1">
          <ProjectSafetyBadge s={s} />
        </div>
      </div>
    </div>
  );
}

function SessionsBlock({
  sessions,
  view,
  h,
  listRef,
}: {
  sessions: SessionMeta[];
  view: View;
  h: SessionHandlers;
  listRef?: Ref<HTMLDivElement>;
}) {
  if (view === "list") {
    return (
      <div ref={listRef} className="flex flex-col gap-1.5">
        {sessions.map((s) => (
          <SessionRow key={s.id} s={s} h={h} />
        ))}
      </div>
    );
  }
  return (
    <div ref={listRef} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {sessions.map((s) => (
        <SessionTile key={s.id} s={s} h={h} />
      ))}
    </div>
  );
}

export function ImportScreen() {
  const importFiles = useStudio((s) => s.importFiles);
  const hasCurrentProject = useStudio((s) => s.clips.length > 0);
  const [drag, setDrag] = useState(false);
  // the saved list shows at once and refreshes underneath (lib/local-cache)
  const {
    items: sessions,
    setItems: setSessions,
    refresh: refreshSessions,
  } = useCachedList<SessionMeta>("caption-projects", listSessions, { topic: "projects" }); // written under /api/projects
  // on screen: scrolled down, the recent projects keep their places and a new one waits; with the top in sight it
  // comes in and the column around it slides to its new centre (lib/steady-list)
  const column = useRef<HTMLDivElement>(null);
  const recentList = useRef<HTMLDivElement>(null);
  const recent = useSteadyList(sessions, recentList, { around: column });
  const [deletedSessions, setDeletedSessions] = useState<DeletedSessionMeta[]>(
    [],
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [deletingForever, setDeletingForever] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    void listDeletedSessions().then(setDeletedSessions).catch(() => {});
    void refreshSessions().catch(() => {});
  }, [refreshSessions]);

  const open = async (id: string) => {
    if (!confirmDiscardUnsavedProject("Open another project")) return;
    setOpening(id);
    try {
      const ok = await loadSession(id);
      if (!ok) {
        setSessions(await listSessions().catch(() => []));
      }
    } finally {
      // success navigates away (this component unmounts); anything else
      // must clear the overlay so a failed load can't wedge the tile
      setOpening(null);
    }
  };

  const remove = async (id: string) => {
    const project = sessions.find((session) => session.id === id);
    if (
      !window.confirm(
        `Delete “${project?.name ?? "this project"}”?\n\nThe cloud copy can be recovered for ${TRASH_KEEP_DAYS} days. This browser's local copy will be removed now.`,
      )
    ) {
      return;
    }
    await deleteSession(id).catch(() => {});
    setSessions((s) => s.filter((x) => x.id !== id));
    setDeletedSessions(await listDeletedSessions());
  };

  const restoreDeleted = async (id: string) => {
    if (!(await restoreDeletedSession(id))) return;
    const [projects, deleted] = await Promise.all([
      listSessions(),
      listDeletedSessions(),
    ]);
    setSessions(projects);
    setDeletedSessions(deleted);
  };

  const permanentlyDelete = async (project: DeletedSessionMeta) => {
    if (
      !window.confirm(
        `Permanently delete “${project.name}”?\n\nThis cannot be undone. Its video, captions, exports, and uploaded source will be deleted now.`,
      )
    ) {
      return;
    }
    setDeletingForever(project.id);
    const deleted = await permanentlyDeleteSession(project.id);
    setDeletingForever(null);
    if (!deleted) {
      window.alert("Could not permanently delete this project. Please retry.");
      return;
    }
    setDeletedSessions((sessions) =>
      sessions.filter((session) => session.id !== project.id),
    );
  };

  const handlers: SessionHandlers = {
    opening,
    renaming,
    draft,
    setDraft,
    startRename: (s) => {
      setDraft(s.name);
      setRenaming(s.id);
    },
    cancelRename: () => setRenaming(null),
    commitRename: async (id) => {
      setRenaming(null);
      const name = draft.trim().slice(0, 120);
      const cur = sessions.find((x) => x.id === id);
      if (!name || !cur || name === cur.name) return;
      setSessions((s) => s.map((x) => (x.id === id ? { ...x, name } : x)));
      const ok = await renameSession(id, name).catch(() => false);
      if (!ok) {
        // roll back to what the server still has
        setSessions((s) =>
          s.map((x) => (x.id === id ? { ...x, name: cur.name } : x)),
        );
      }
    },
    open,
    remove,
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length && confirmDiscardUnsavedProject("Start a new project")) {
        importFiles(files);
      }
    },
    [importFiles],
  );

  return (
    // this pane is the whole window and scrolls by itself, top bar and all: it keeps its own bar's place
    // (data-fills-window="scrolls", index.css), so the top bar is as wide as on every other page and nothing moves when
    // the list grows
    <div data-fills-window="scrolls" className="relative flex h-full flex-col overflow-y-scroll bg-zinc-950 text-zinc-200">
      <AppBar
        tool="Caption Studio"
        onHome={(event) => {
          if (!confirmDiscardUnsavedProject("Leave this project")) {
            event.preventDefault();
          }
        }}
      >
        {hasCurrentProject && <PersistenceBadge />}
      </AppBar>
      <div ref={column} className="flex flex-1 flex-col items-center justify-center py-8">
      <ToolIntro icon={Captions} title="Caption Studio" line="Transcribe · caption · export with alpha" className="mt-0" />

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={dropZoneClass(drag, "w-[560px] max-w-[90vw] shrink-0 cursor-pointer")}
      >
        <DropZoneText
          title="Drop videos here, or click to browse"
          hint="MP4 · WebM · MOV — drop several to caption them as one batch"
        />
        <input
          type="file"
          multiple
          accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (
              files.length &&
              confirmDiscardUnsavedProject("Start a new project")
            ) {
              importFiles(files);
            }
            e.target.value = "";
          }}
        />
      </label>

      {recent.length > 0 && (
        <div className="mt-8 w-[560px] max-w-[90vw]">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              <Clock className="h-3.5 w-3.5" /> Recent projects
            </h2>
            <div className="flex items-center gap-2">
              {sessions.length > RECENT_COUNT && (
                <button
                  onClick={() => setShowAll(true)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-violet-400 hover:bg-zinc-800 hover:text-violet-300"
                >
                  All projects ({sessions.length}) →
                </button>
              )}
              <ViewToggle view={view} onChange={changeView} />
            </div>
          </div>
          <SessionsBlock
            sessions={recent.slice(0, RECENT_COUNT)}
            view={view}
            h={handlers}
            listRef={recentList}
          />
        </div>
      )}

      {deletedSessions.length > 0 && (
        <details className="mt-4 w-[560px] max-w-[90vw] rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Trash · {deletedSessions.length} project
            {deletedSessions.length === 1 ? "" : "s"} · recoverable for{" "}
            {TRASH_KEEP_DAYS} days
          </summary>
          <div className="mt-2 space-y-1.5">
            {deletedSessions.map((project) => (
              <div
                key={project.id}
                className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/50 px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-zinc-300">
                    {project.name}
                  </p>
                  <p className="text-[10px] text-zinc-600">
                    Deleted {new Date(project.deletedAt).toLocaleDateString()} ·{" "}
                    purges{" "}
                    {new Date(project.recoverableUntil).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => void restoreDeleted(project.id)}
                  disabled={deletingForever === project.id}
                  className="flex shrink-0 items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-violet-500 hover:text-violet-300"
                >
                  <RotateCcw className="h-3 w-3" /> Restore
                </button>
                <button
                  onClick={() => void permanentlyDelete(project)}
                  disabled={deletingForever === project.id}
                  className="flex shrink-0 items-center gap-1 rounded border border-red-950 px-2 py-1 text-[11px] font-medium text-red-500 hover:border-red-700 hover:bg-red-950/30 hover:text-red-300 disabled:cursor-wait disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  {deletingForever === project.id ? "Deleting…" : "Delete now"}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="mb-2 mt-10 grid w-[560px] max-w-[90vw] grid-cols-3 gap-3 text-center text-xs text-zinc-500">
        <div className="rounded-lg bg-zinc-900/60 px-3 py-3">
          <span className="mb-1 block text-sm font-medium text-zinc-300">
            1 · Transcribe
          </span>
          Whisper AI runs 100% on your device
        </div>
        <div className="rounded-lg bg-zinc-900/60 px-3 py-3">
          <span className="mb-1 block text-sm font-medium text-zinc-300">
            2 · Caption
          </span>
          Click the transcript to jump around
        </div>
        <div className="rounded-lg bg-zinc-900/60 px-3 py-3">
          <span className="mb-1 block text-sm font-medium text-zinc-300">
            3 · Export
          </span>
          ProRes 4444 / WebM with real alpha
        </div>
      </div>

      {/* all-projects overlay */}
      {showAll && (
        <div className="absolute inset-0 z-10 flex flex-col bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
            <button
              onClick={() => setShowAll(false)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <h2 className="text-sm font-semibold text-zinc-200">
              All projects ({sessions.length})
            </h2>
            <ViewToggle view={view} onChange={changeView} />
          </div>
          <div className="flex-1 overflow-y-scroll px-5 py-4">
            <div
              className={
                view === "grid" ? "mx-auto max-w-5xl" : "mx-auto max-w-2xl"
              }
            >
              <SessionsBlock sessions={sessions} view={view} h={handlers} />
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
