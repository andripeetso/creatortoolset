import { Link } from "react-router";
import { Circle, FolderOpen, MoreHorizontal, Trash2 } from "lucide-react";
import { AppBar } from "@/components/AppBar";
import { Picture } from "@/components/Picture";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { canUse, useMe } from "@/lib/auth";
import { useCachedList } from "@/lib/local-cache";
import { canRecordScreen, openRecorder, tellRecorder, useLocalRecordings, useRecorderState, type LocalRecording, type RecorderPhase, type ShareDest } from "@/lib/mac-record";
import { listReviewAssets, thumbUrl } from "@/lib/review";
import { timeAgo } from "@/lib/exports";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/lib/dialogs";

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

/**
 * Screen Recorder (its own tool): New recording opens the Mac app's toolbar; the recordings kept on this Mac open in
 * the editor, or are sent on (Review, Video Notes, a guide), shown in Finder or thrown away. Review's recent
 * recordings stay below.
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

  const throwAway = async (r: LocalRecording) => {
    if (!(await confirmDialog({ title: `Throw away “${r.name}”?`, body: "The recording is deleted from this Mac. This cannot be undone.", ok: "Throw away", danger: true }))) return;
    tellRecorder(`delete:${r.id}`);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100">
      <AppBar tool="Screen Recorder" />
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8">
        {!inApp ? (
          <section className="rounded-xl border border-zinc-800 p-6">
            <h1 className="text-lg font-semibold">Screen recording runs in the Mac app</h1>
            <p className="mt-1 text-sm text-zinc-400">Open this page in Creator Toolset for Mac (macOS 15 or later).</p>
          </section>
        ) : (
          <>
            <section className="flex flex-col items-center gap-3 rounded-xl border border-zinc-800 py-8">
              <Button size="lg" className="h-12 bg-red-600 px-8 text-base text-white hover:bg-red-500" onClick={openRecorder}>
                <Circle className="fill-white" /> New recording
              </Button>
              {busy && (
                <div className="flex items-center gap-2 text-sm text-zinc-200">
                  <Circle className={cn("h-3 w-3 fill-red-500 text-red-500", phase === "recording" && "animate-pulse")} />
                  {PHASE[phase] ?? phase}
                </div>
              )}
              <p className="px-4 text-center text-xs text-zinc-500">
                Pick the screen, a camera and a microphone, then Start. Nothing uploads until you send it.
                {shortcut && <> From any app: {shortcut}.</>}
              </p>
              {folder && (
                <div className="flex w-full max-w-md items-center gap-2 px-4 text-sm">
                  <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate text-zinc-300" title={folder}>
                    {folder}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => tellRecorder("folder")}>
                    Change…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => tellRecorder("show")}>
                    Show
                  </Button>
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-400">On this Mac</h2>
              {recordings === null ? null : recordings.length === 0 ? (
                <p className="text-sm text-zinc-500">No recordings on this Mac yet.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {recordings.map((r) => (
                    <div key={r.id} className="group relative overflow-hidden rounded-lg border border-zinc-800 hover:border-zinc-600">
                      <Link to={`/record/${r.id}`} className="block">
                        <div className="aspect-video w-full bg-zinc-900">
                          <Picture src={`ctlocal://${r.id}/thumb.jpg`} alt="" className="h-full w-full object-cover" />
                        </div>
                        <div className="p-2">
                          <div className="truncate text-sm">{r.name}</div>
                          <div className="text-xs text-zinc-500">
                            {duration(r.durationMs)} · {new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                          </div>
                        </div>
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label="More"
                            className="absolute right-1.5 top-1.5 rounded bg-black/60 p-1 text-white hover:bg-black/80"
                          >
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
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {recent && recent.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-400">Recent recordings in Review</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
