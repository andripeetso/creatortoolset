import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Circle, FolderOpen, MoreHorizontal, ScreenShare, Trash2 } from "lucide-react";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { Picture } from "@/components/Picture";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { canUse, useMe } from "@/lib/auth";
import { useCachedList } from "@/lib/local-cache";
import { canRecordScreen, openRecorder, tellRecorder, throwAwayRecording, useLocalRecordings, useRecorderState, type LocalRecording, type RecorderPhase, type ShareDest } from "@/lib/mac-record";
import { localFileUrl, localFilesOverlap } from "@/lib/local-files";
import { listReviewAssets, thumbUrl } from "@/lib/review";
import { timeAgo } from "@/lib/exports";
import { cn } from "@/lib/utils";
import { BrowseBar } from "@/components/browse/Bar";
import { byName, matches, persistSort, storedSort, useBrowseView } from "@/components/browse/views";

const PHASE: Partial<Record<RecorderPhase, string>> = {
  countdown: "Starting…",
  recording: "Recording",
  paused: "Paused",
  saving: "Saving…",
  uploading: "Uploading…",
};

const SHARES: { dest: ShareDest; label: string }[] = [
  { dest: "review", label: "Send to Review" },
  { dest: "notes", label: "Send to Video Notes" },
  { dest: "guide", label: "Make a guide" },
];

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A recording's thumbnail: the app's own file, or in an older app a copy read in its turn (lib/local-files.ts). */
function LocalThumb({ id }: { id: string }) {
  const file = `ctlocal://${id}/thumb.jpg`;
  const direct = localFilesOverlap();
  const [copy, setSrc] = useState("");
  const src = direct ? file : copy;
  useEffect(() => {
    if (direct) return;
    let gone = false;
    let release = () => {};
    localFileUrl(file).then(
      (f) => {
        if (gone) return f.release();
        release = f.release;
        setSrc(f.url);
      },
      () => {},
    );
    return () => {
      gone = true;
      release();
    };
  }, [file, direct]);
  // the whole recording, whatever its shape: a tall window is not cut down to its top strip
  return src ? <Picture src={src} alt="" className="h-full w-full object-contain" /> : null;
}

/** A recording's own name, or for one still called by its date and time ("Screen recording 2026-11-10 21.34.32") that
 *  moment as a person writes it: the names of a day's recordings differ only at their end, which a card cuts off. */
const NAMED_BY_TIME = /^Screen recording \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}$/;
const when = (r: LocalRecording) => new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const title = (r: LocalRecording) => (NAMED_BY_TIME.test(r.name) ? when(r) : r.name);

const SORTS = ["recent", "name"] as const;
const SORT_KEY = "recorder:sort";

/** A recording's Throw away and More (send on, Show in Finder): the same on its card and its row. */
function RecordingActions({ r, onThrowAway }: { r: LocalRecording; onThrowAway: () => void }) {
  return (
    <>
      <button
        type="button"
        aria-label={`Throw away ${title(r)}`}
        title="Throw away (to the Trash)"
        onClick={onThrowAway}
        className="rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`More for ${title(r)}`} className="rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SHARES.map((sh) => (
            <DropdownMenuItem key={sh.dest} onSelect={() => tellRecorder(`share:${r.id}:${sh.dest}`)}>
              {sh.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => tellRecorder(`reveal:${r.id}`)}>
            <FolderOpen /> Show in Finder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** The folder's path as the Finder says it: the home folder is ~. */
const shortPath = (folder: string) => folder.replace(/^\/Users\/[^/]+/, "~");

/**
 * Screen Recorder (its own tool, and where its tile leads): the recordings kept on this Mac, each opening in the
 * editor, sent on (Review, Video Notes, a guide), shown in Finder or thrown away; New recording opens the Mac app's
 * toolbar. Review's recent recordings stay below.
 */
export default function ScreenRecorderPage() {
  const me = useMe();
  const inApp = canRecordScreen();
  const { phase, busy, folder, shortcut } = useRecorderState();
  const recordings = useLocalRecordings();

  // Review's list: the saved copy (warmed after sign-in) shows at once and refreshes underneath
  const { items: reviewAssets } = useCachedList(canUse(me, "review") ? "/api/review" : null, listReviewAssets);
  const recent = reviewAssets
    .filter((a) => a.versions.some((v) => v.screen))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, 12);

  const throwAway = (r: LocalRecording) => void throwAwayRecording(r);
  const [view, setView] = useBrowseView("recorder");
  const [find, setFind] = useState("");
  const [sort, setSort] = useState(() => storedSort(SORT_KEY, SORTS));
  // the Mac app sends them newest first; Name goes by the name a card shows
  const listed = (recordings ?? [])
    .filter((r) => matches(find, title(r), r.name))
    .sort((a, b) => (sort === "name" ? byName({ name: title(a) }, { name: title(b) }) : 0));

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100">
      {/* the tool's one main action sits in the bar, where every tool has its own */}
      <AppBar tool="Screen Recorder">
        {inApp && busy && (
          <span className="flex items-center gap-2 text-sm text-zinc-300">
            <Circle className={cn("h-2.5 w-2.5 fill-red-500 text-red-500", phase === "recording" && "animate-pulse")} />
            {PHASE[phase] ?? phase}
          </span>
        )}
        {inApp && (
          <Button size="sm" onClick={openRecorder} title={shortcut ? `New recording (${shortcut} from any app)` : undefined} className="bg-violet-600 text-white hover:bg-violet-500">
            <Circle className="fill-current" /> New recording
            {shortcut && <kbd className="ml-1 hidden rounded bg-white/15 px-1 text-[11px] font-normal sm:inline">{shortcut}</kbd>}
          </Button>
        )}
      </AppBar>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <ToolIntro icon={ScreenShare} title="Screen Recorder" line="Record your screen, a window or an area, with your camera and voice" className="mt-4" />
        {!inApp ? (
          <section className="rounded-xl border border-zinc-800 p-6">
            <h2 className="text-base font-semibold">Screen recording runs in the Mac app</h2>
            <p className="mt-1 text-sm text-zinc-400">Open this page in Creator Toolset for Mac (macOS 15 or later).</p>
          </section>
        ) : (
          <section className="mb-10">
            <div className="mb-4 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-sm font-medium text-zinc-300">
                On this Mac
                {!!recordings?.length && <span className="ml-1.5 tabular-nums text-zinc-500">{recordings.length}</span>}
              </h2>
              {folder && (
                <div className="ml-auto flex min-w-0 items-center text-sm">
                  <button
                    type="button"
                    onClick={() => tellRecorder("show")}
                    title={`${folder}: show in Finder`}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="truncate">{shortPath(folder)}</span>
                  </button>
                  <button type="button" onClick={() => tellRecorder("folder")} className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
                    Change…
                  </button>
                </div>
              )}
            </div>
            {recordings === null ? null : recordings.length === 0 ? (
              <button
                type="button"
                onClick={openRecorder}
                className="mx-auto mt-10 flex w-full max-w-lg flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-800 px-6 py-16 text-center hover:border-violet-500/60"
              >
                <ScreenShare className="h-10 w-10 text-zinc-600" />
                <span className="text-base font-medium text-zinc-200">Make your first recording</span>
                {shortcut && <kbd className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400">{shortcut}</kbd>}
              </button>
            ) : (
              <>
              <BrowseBar
                search={{ value: find, onChange: setFind, placeholder: "Search recordings (⌘K)" }}
                sort={{
                  value: sort,
                  onChange: (v) => {
                    setSort(v);
                    persistSort(SORT_KEY, v);
                  },
                  label: "Sort recordings",
                  options: [
                    { id: "recent", label: "Recent" },
                    { id: "name", label: "Name" },
                  ],
                }}
                view={{ value: view, onChange: setView }}
              />
              {listed.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">No matches.</p>}
              {view === "list" ? (
                <div className="flex flex-col gap-1.5">
                  {listed.map((r) => (
                    <div key={r.id} className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 py-1.5 pl-1.5 pr-2 transition-colors hover:border-violet-500/50">
                      <Link to={`/record/${r.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="relative block h-10 w-16 shrink-0 overflow-hidden rounded bg-black">
                          <LocalThumb id={r.id} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-zinc-100">{title(r)}</span>
                          <span className="mt-0.5 block truncate text-xs tabular-nums text-zinc-500">
                            {NAMED_BY_TIME.test(r.name) ? "" : `${when(r)} · `}
                            {r.width} × {r.height}
                            {r.camera ? " · camera" : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-zinc-500">{duration(r.durationMs)}</span>
                      </Link>
                      <RecordingActions r={r} onThrowAway={() => throwAway(r)} />
                    </div>
                  ))}
                </div>
              ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {listed.map((r) => (
                  <div key={r.id} className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-violet-500/60">
                    <Link to={`/record/${r.id}`} className="relative block aspect-video bg-black">
                      <LocalThumb id={r.id} />
                      <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
                        {duration(r.durationMs)}
                      </span>
                    </Link>
                    <div className="flex items-center gap-1 py-2.5 pl-3.5 pr-2">
                      <Link to={`/record/${r.id}`} className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-100">{title(r)}</div>
                        <div className="mt-0.5 truncate text-xs tabular-nums text-zinc-500">
                          {NAMED_BY_TIME.test(r.name) ? "" : `${when(r)} · `}
                          {r.width} × {r.height}
                          {r.camera ? " · camera" : ""}
                        </div>
                      </Link>
                      <RecordingActions r={r} onThrowAway={() => throwAway(r)} />
                    </div>
                  </div>
                ))}
              </div>
              )}
              </>
            )}
          </section>
        )}

        {recent && recent.length > 0 && (
          <section>
            <h2 className="mb-4 text-sm font-medium text-zinc-300">In Review</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((a) => (
                <Link
                  key={a.id}
                  to={`/review/${a.id}`}
                  className="group overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-violet-500/60"
                >
                  <div className="aspect-video bg-black">
                    <Picture src={thumbUrl(a)} alt="" className="h-full w-full object-contain" />
                  </div>
                  <div className="px-3.5 py-2.5">
                    <div className="truncate text-sm font-medium text-zinc-100">{a.name}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">{timeAgo(a.updatedAt ?? a.createdAt)}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
