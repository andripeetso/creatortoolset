import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Circle, FolderOpen, MoreHorizontal, Trash2 } from "lucide-react";
import { AppBar } from "@/components/AppBar";
import { Picture } from "@/components/Picture";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { canUse, useMe } from "@/lib/auth";
import { useCachedList } from "@/lib/local-cache";
import { canRecordScreen, openRecorder, tellRecorder, useLocalRecordings, useRecorderState, type LocalRecording, type RecorderPhase, type ShareDest } from "@/lib/mac-record";
import { localFileUrl, localFilesOverlap } from "@/lib/local-files";
import { listReviewAssets, thumbUrl } from "@/lib/review";
import { timeAgo } from "@/lib/exports";
import { cn } from "@/lib/utils";

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
  return src ? <Picture src={src} alt="" className="h-full w-full object-cover object-top" /> : null;
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

  // the Mac app asks before it moves a recording to the Trash (its own alert, in every version of it), so the page
  // does not ask as well: that was two questions for one press, and the page's said "cannot be undone"
  const throwAway = (r: LocalRecording) => tellRecorder(`delete:${r.id}`);

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100">
      <AppBar tool="Screen Recorder" />
      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8">
        {!inApp ? (
          <section className="rounded-xl border border-zinc-800 p-6">
            <h1 className="text-lg font-semibold">Screen recording runs in the Mac app</h1>
            <p className="mt-1 text-sm text-zinc-400">Open this page in Creator Toolset for Mac (macOS 15 or later).</p>
          </section>
        ) : (
          <>
            <section className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Button size="lg" className="h-11 bg-red-600 px-6 text-base text-white hover:bg-red-500" onClick={openRecorder}>
                <Circle className="fill-white" /> New recording
              </Button>
              {shortcut && <kbd className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400">{shortcut}</kbd>}
              {busy && (
                <div className="flex items-center gap-2 text-sm text-zinc-200">
                  <Circle className={cn("h-3 w-3 fill-red-500 text-red-500", phase === "recording" && "animate-pulse")} />
                  {PHASE[phase] ?? phase}
                </div>
              )}
              {folder && (
                <div className="ml-auto flex min-w-0 items-center gap-1 text-sm">
                  <button
                    type="button"
                    onClick={() => tellRecorder("show")}
                    title={`${folder}: show in Finder`}
                    className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="truncate">{shortPath(folder)}</span>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => tellRecorder("folder")}>
                    Change…
                  </Button>
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-400">On this Mac</h2>
              {recordings === null ? null : recordings.length === 0 ? (
                <p className="text-sm text-zinc-500">No recordings on this Mac yet.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {recordings.map((r) => (
                    <div key={r.id} className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 hover:border-zinc-600">
                      <Link to={`/record/${r.id}`} className="block">
                        <div className="relative aspect-video w-full bg-zinc-900">
                          <LocalThumb id={r.id} />
                          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
                            {duration(r.durationMs)}
                          </span>
                        </div>
                        <div className="p-2.5">
                          <div className="truncate text-sm">{r.name}</div>
                          <div className="text-xs text-zinc-500">
                            {new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                          </div>
                        </div>
                      </Link>
                      <div className="absolute right-1.5 top-1.5 flex gap-1">
                        <button
                          type="button"
                          aria-label={`Throw away ${r.name}`}
                          title="Throw away (to the Trash)"
                          onClick={() => throwAway(r)}
                          className="rounded bg-black/60 p-1 text-white opacity-0 hover:bg-red-600 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" aria-label="More" className="rounded bg-black/60 p-1 text-white hover:bg-black/80">
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {SHARES.map((s) => (
                              <DropdownMenuItem key={s.dest} onSelect={() => tellRecorder(`share:${r.id}:${s.dest}`)}>
                                {s.label}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem onSelect={() => tellRecorder(`reveal:${r.id}`)}>
                              <FolderOpen /> Show in Finder
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-red-400" onSelect={() => throwAway(r)}>
                              <Trash2 /> Throw away
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {recent && recent.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-400">Recent recordings in Review</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {recent.map((a) => (
                <Link key={a.id} to={`/review/${a.id}`} className="group overflow-hidden rounded-lg border border-zinc-800 hover:border-zinc-600">
                  <div className="aspect-video w-full bg-zinc-900">
                    <Picture src={thumbUrl(a)} alt="" className="h-full w-full object-cover" />
                  </div>
                  <div className="p-2">
                    <div className="truncate text-sm">{a.name}</div>
                    <div className="text-xs text-zinc-500">{timeAgo(a.updatedAt ?? a.createdAt)}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
