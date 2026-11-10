import { SendToCleanerButton } from "@/components/SendToCleanerButton";
import { useEffect, useState } from "react";
import { useCachedList } from "@/lib/local-cache";
import { useLocation, useNavigate } from "react-router";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  FilePlus2,
  Film,
  LayoutGrid,
  Pencil,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { isEditorBusy, useStudio, playerRef } from "@/lib/store";
import {
  flushPendingSave,
  listSessions,
  loadSession,
  type SessionMeta,
} from "@/lib/persist";
import { fmtClock } from "@/lib/ass";
import { FONT_OPTIONS, fontWeightFor } from "@/lib/types";
import { ImportScreen } from "@/components/ImportScreen";
import { Player } from "@/components/Player";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { Timeline } from "@/components/Timeline";
import { ClipBar } from "@/components/ClipBar";
import { StylePanel } from "@/components/StylePanel";
import { ExportDialog } from "@/components/ExportDialog";
import { HelpDialog } from "@/components/HelpDialog";
import { ProjectSetupDialog } from "@/components/ProjectSetupDialog";
import { ProjectSettingsDialog } from "@/components/ProjectSettingsDialog";
import { AppBar } from "@/components/AppBar";
import { confirmDiscardUnsavedProject } from "@/lib/persistence-guard";
import { PersistenceBadge } from "@/components/PersistenceStatus";

/** Header dropdown: jump between saved projects or back to all projects. */
function ProjectSwitcher() {
  const fileName = useStudio((s) => s.fileName);
  const projectId = useStudio((s) => s.projectId);
  const reset = useStudio((s) => s.reset);
  const [open, setOpen] = useState(false);
  // the projects list's saved copy (ImportScreen's key): the menu opens full, and reads again underneath
  const { items: sessions, refresh } = useCachedList<SessionMeta>("caption-projects", listSessions, { topic: "projects" });
  const [busy, setBusy] = useState(false);

  const toggle = () => {
    if (!open) void refresh().catch(() => {});
    setOpen(!open);
  };

  const switchTo = async (id: string) => {
    setOpen(false);
    if (id === projectId || busy) return;
    if (!confirmDiscardUnsavedProject("Switch projects")) return;
    setBusy(true);
    await flushPendingSave();
    await loadSession(id);
    setBusy(false);
  };

  const goHome = async () => {
    setOpen(false);
    if (!confirmDiscardUnsavedProject("Leave this project")) return;
    await flushPendingSave();
    reset();
  };

  return (
    <div className="relative">
      <button
        onClick={toggle}
        title="Switch project"
        className="flex max-w-[36vw] items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <span className="truncate">{busy ? "Opening…" : fileName}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl">
            <button
              onClick={goHome}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
            >
              <LayoutGrid className="h-3.5 w-3.5 text-zinc-500" /> All projects
            </button>
            {sessions.length > 0 && (
              <div className="my-1 border-t border-zinc-800" />
            )}
            <div className="max-h-64 overflow-y-auto">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => switchTo(s.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800"
                >
                  <Film className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-zinc-200">
                      {s.name}
                    </span>
                    <span className="block text-[10px] text-zinc-500">
                      {new Date(s.updatedAt).toLocaleString()}
                      {s.duration > 0 && <> · {fmtClock(s.duration)}</>}
                    </span>
                  </span>
                  {s.id === projectId && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The switcher plus a pencil that turns the project name into an input. */
function ProjectName() {
  const fileName = useStudio((s) => s.fileName);
  const setFileName = useStudio((s) => s.setFileName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const commit = () => {
      setFileName(draft);
      setEditing(false);
    };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        maxLength={120}
        className="w-64 rounded-md border border-violet-500 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none"
      />
    );
  }
  return (
    <div className="group flex items-center">
      <ProjectSwitcher />
      <button
        onClick={() => {
          setDraft(fileName);
          setEditing(true);
        }}
        title="Rename project"
        className="rounded p-1 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

function TabConflictBanner() {
  const tabConflict = useStudio((s) => s.tabConflict);
  if (!tabConflict) return null;
  return (
    <span
      title="Caption Studio is open in another browser tab. Both tabs autosave — the stale one silently overwrites the fresh one's work (transcripts, applies). Close one of them."
      className="flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-400"
    >
      <TriangleAlert className="h-3 w-3" /> Open in 2 tabs — saves collide
    </span>
  );
}

const MIN_TRANSCRIPT_W = 420;
const TRANSCRIPT_W_KEY = "cap-transcript-width";
/** Room to keep for the player + style panel when dragging the divider. */
const RESERVED_W = 600;

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const projectLibraryRequested =
    new URLSearchParams(location.search).get("view") === "projects";
  // /captions?project=<id>: open that project (Review's "Caption Studio")
  const projectRequested = new URLSearchParams(location.search).get("project");
  const cleanerClipRequested = new URLSearchParams(location.search).get(
    "cleanerClip",
  );
  useEffect(() => {
    if (!projectRequested) return;
    navigate("/captions", { replace: true });
    if (
      useStudio.getState().projectId === projectRequested &&
      !cleanerClipRequested
    )
      return;
    if (!confirmDiscardUnsavedProject("Open another project")) return;
    void (async () => {
      await flushPendingSave();
      if (
        await loadSession(projectRequested, { server: !!cleanerClipRequested })
      ) {
        if (cleanerClipRequested)
          useStudio.getState().switchClip(cleanerClipRequested);
        useStudio.setState({ projectLibraryOpen: false });
      }
    })();
  }, [navigate, projectRequested, cleanerClipRequested]);
  useEffect(() => {
    if (!projectLibraryRequested) return;
    useStudio.getState().openProjectLibrary();
    // Consume the request after recording it in the store. Project selection
    // can then close the library normally without the query reopening it.
    navigate("/captions", { replace: true });
  }, [navigate, projectLibraryRequested]);
  // warm every caption font up front — fonts otherwise load on first
  // use, so captions paint in a fallback face and visibly swap once the
  // file arrives (again on every font switch in the style panel)
  useEffect(() => {
    for (const f of FONT_OPTIONS) {
      const w = fontWeightFor(f.family);
      void document.fonts.load(`${w} 16px "${f.family}"`);
    }
  }, []);

  const videoUrl = useStudio((s) => s.videoUrl);
  const projectLibraryOpen = useStudio((s) => s.projectLibraryOpen);
  const cues = useStudio((s) => s.cues);
  const texts = useStudio((s) => s.texts);
  const reset = useStudio((s) => s.reset);
  const importFiles = useStudio((s) => s.importFiles);
  const setupPending = useStudio((s) => s.setupPending);
  const editorBusy = useStudio(isEditorBusy);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transcriptW, setTranscriptW] = useState(() => {
    const saved = Number(localStorage.getItem(TRANSCRIPT_W_KEY));
    return Number.isFinite(saved) && saved > MIN_TRANSCRIPT_W
      ? saved
      : MIN_TRANSCRIPT_W;
  });

  const backToToolset = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!confirmDiscardUnsavedProject("Leave this project")) e.preventDefault();
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = transcriptW;
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(
        Math.max(MIN_TRANSCRIPT_W, startW + ev.clientX - startX),
        Math.max(MIN_TRANSCRIPT_W, window.innerWidth - RESERVED_W),
      );
      setTranscriptW(latest);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem(TRANSCRIPT_W_KEY, String(latest));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // another handler (e.g. caption-box nudging) already claimed this key
      if (e.defaultPrevented) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      if (isEditorBusy(useStudio.getState())) {
        e.preventDefault();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        const v = playerRef.video;
        if (v) {
          if (v.paused) v.play();
          else v.pause();
        }
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        // a frame, Shift a second, paused: Review's keys
        e.preventDefault();
        const st = useStudio.getState();
        const step = e.shiftKey ? 1 : 1 / st.fps;
        playerRef.video?.pause();
        st.seek(st.currentTime + (e.code === "ArrowRight" ? step : -step));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useStudio.getState().redoEdit();
        else useStudio.getState().undoEdit();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        // typing in the inline editor never lands here — the textarea
        // target is filtered above, so a selected text is safe to delete
        const st = useStudio.getState();
        if (st.selectedTextId != null) {
          e.preventDefault();
          st.deleteText(st.selectedTextId);
        }
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (projectLibraryRequested || projectLibraryOpen || !videoUrl) {
    return <ImportScreen />;
  }

  return (
    <div
      aria-busy={editorBusy}
      className="relative isolate flex h-screen flex-col bg-zinc-950 text-zinc-200"
    >
      {/* top bar */}
      <AppBar
        tool="Caption Studio"
        onHome={backToToolset}
        trail={
          <span className="flex min-w-0 items-center gap-3 font-normal">
            <ProjectName />
            <PersistenceBadge />
            <TabConflictBanner />
          </span>
        }
        className="bg-zinc-925"
      >
          <button
            onClick={() => setSettingsOpen(true)}
            title="Project settings"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            title="Shortcuts & tips (?)"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
          >
            <CircleHelp className="h-4 w-4" />
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
            <FilePlus2 className="h-3.5 w-3.5" /> New project
            <input
              type="file"
              multiple
              accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) {
                  if (!confirmDiscardUnsavedProject("Start a new project")) {
                    e.target.value = "";
                    return;
                  }
                  reset();
                  importFiles(files);
                }
                e.target.value = "";
              }}
            />
          </label>
          <SendToCleanerButton />
          <button
            onClick={() => setExportOpen(true)}
            disabled={cues.length === 0 && texts.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" /> Export
          </button>
      </AppBar>

      {/* main area */}
      <div className="flex min-h-0 flex-1">
        <div style={{ width: transcriptW }} className="shrink-0">
          <TranscriptPanel />
        </div>
        <div
          onPointerDown={startResize}
          onDoubleClick={() => {
            setTranscriptW(MIN_TRANSCRIPT_W);
            localStorage.removeItem(TRANSCRIPT_W_KEY);
          }}
          title="Drag to resize the transcript — double-click to reset"
          className="-ml-1 w-1.5 shrink-0 cursor-col-resize hover:bg-violet-500/50 active:bg-violet-500/70"
        />
        <div className="min-w-0 flex-1 p-3">
          <Player />
        </div>
        <StylePanel />
      </div>

      {/* clip pool + timeline */}
      <ClipBar />
      <Timeline />

      {editorBusy && (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-40 cursor-wait bg-zinc-950/45"
        />
      )}

      {setupPending && <ProjectSetupDialog />}
      {settingsOpen && (
        <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
