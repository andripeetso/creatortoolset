import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Circle, FolderOpen, Square } from "lucide-react";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canUse, useMe } from "@/lib/auth";
import { canRecordScreen, recordScreen, tellRecorder, useRecorderState, type RecordTarget } from "@/lib/mac-record";
import { listReviewAssets, thumbUrl, type ReviewAsset } from "@/lib/review";
import { timeAgo } from "@/lib/exports";
import { cn } from "@/lib/utils";

const TARGET_KEY = "record.target";
const PHASE: Record<string, string> = {
  countdown: "Starting…",
  recording: "Recording",
  paused: "Paused",
  saving: "Saving…",
  uploading: "Uploading…",
};

/**
 * Screen Recorder: the Mac app's recorder
 * (apps/mac Recorder.swift) with where it goes, what it hears and the folder. Review and Video Notes start it too.
 */
export default function ScreenRecorderPage() {
  const me = useMe();
  const inApp = canRecordScreen();
  const state = useRecorderState();
  const targets = (
    [
      { id: "review", name: "Review", desc: "Zoom & pointer: zooms where you clicked, a smooth pointer, a background.", ok: canUse(me, "review") },
      { id: "notes", name: "Video Notes", desc: "Transcript, summary, chapters and takeaways.", ok: canUse(me, "notes") },
      { id: "mac", name: "Only this Mac", desc: "Saved in the recordings folder. Nothing uploads.", ok: true },
    ] as const
  ).filter((t) => t.ok);
  const [target, setTarget] = useState<RecordTarget>(() => {
    try {
      const saved = localStorage.getItem(TARGET_KEY) as RecordTarget | null;
      if (saved && targets.some((t) => t.id === saved)) return saved;
    } catch {
      /* private window */
    }
    return targets[0].id;
  });
  const pick = (t: RecordTarget) => {
    setTarget(t);
    try {
      localStorage.setItem(TARGET_KEY, t);
    } catch {
      /* private window */
    }
  };

  const [recent, setRecent] = useState<ReviewAsset[] | null>(null);
  const busy = !!state && state.phase !== "idle";
  useEffect(() => {
    if (busy || !canUse(me, "review")) return;
    listReviewAssets()
      .then((all) =>
        setRecent(
          all
            .filter((a) => a.versions.some((v) => v.screen))
            .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
            .slice(0, 12),
        ),
      )
      .catch(() => setRecent([]));
  }, [busy, me]);

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
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-400">When you stop, it goes to</h2>
              <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={target === t.id}
                    disabled={busy}
                    onClick={() => pick(t.id)}
                    className={cn(
                      "rounded-xl border p-3 text-left transition-colors disabled:opacity-60",
                      target === t.id ? "border-violet-500 bg-violet-950/40" : "border-zinc-800 hover:bg-zinc-900",
                    )}
                  >
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="mt-1 text-xs text-zinc-400">{t.desc}</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="flex flex-col items-center gap-3 rounded-xl border border-zinc-800 py-8">
              {busy ? (
                <>
                  <div className="flex items-center gap-2 text-sm text-zinc-200">
                    <Circle className={cn("h-3 w-3 fill-red-500 text-red-500", state.phase === "recording" && "animate-pulse")} />
                    {PHASE[state.phase]}
                  </div>
                  {(state.phase === "recording" || state.phase === "paused") && (
                    <Button variant="outline" onClick={() => tellRecorder("stop")}>
                      <Square className="fill-current" /> Stop
                    </Button>
                  )}
                </>
              ) : (
                <Button size="lg" className="h-12 bg-red-600 px-8 text-base text-white hover:bg-red-500" onClick={() => recordScreen(target)}>
                  <Circle className="fill-white" /> Start recording
                </Button>
              )}
              <p className="px-4 text-center text-xs text-zinc-500">
                Records the screen the pointer is on, after a 3-2-1. ⌥⌘R starts from anywhere (to Review), ⌥⌘. stops.
              </p>
            </section>

            {state && (
              <section className="space-y-1 rounded-xl border border-zinc-800 p-4">
                <label className="flex items-center justify-between gap-4 py-2 text-sm">
                  My microphone
                  <Switch checked={state.mic} disabled={busy} onCheckedChange={(on) => tellRecorder(on ? "mic-on" : "mic-off")} />
                </label>
                <label className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span>
                    The Mac's sound
                    <span className="block text-xs text-zinc-500">Its own track in the file. Zoom & pointer videos keep the voice only.</span>
                  </span>
                  <Switch checked={state.sound} disabled={busy} onCheckedChange={(on) => tellRecorder(on ? "sound-on" : "sound-off")} />
                </label>
                <div className="flex items-center gap-2 border-t border-zinc-800 pt-3 text-sm">
                  <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate text-zinc-300" title={state.folder}>
                    {state.folder}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => tellRecorder("folder")}>
                    Change…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => tellRecorder("show")}>
                    Show
                  </Button>
                </div>
              </section>
            )}
          </>
        )}

        {recent && recent.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-400">Recent recordings in Review</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {recent.map((a) => (
                <Link key={a.id} to={`/review/${a.id}`} className="group overflow-hidden rounded-lg border border-zinc-800 hover:border-zinc-600">
                  <img src={thumbUrl(a)} alt="" loading="lazy" className="aspect-video w-full bg-zinc-900 object-cover" />
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
