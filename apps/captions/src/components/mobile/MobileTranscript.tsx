import { useEffect, useRef } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { useStudio } from "@/lib/store";
import { fmtClock } from "@/lib/ass";

/**
 * The caption list under the player: tap a caption to seek there, the
 * active one highlights and stays in view during playback. Text edits
 * happen in MobileTextEditor; undo/redo live here.
 */
export function MobileTranscript() {
  const cues = useStudio((s) => s.cues);
  const currentTime = useStudio((s) => s.currentTime);
  const seek = useStudio((s) => s.seek);
  const undoEdit = useStudio((s) => s.undoEdit);
  const redoEdit = useStudio((s) => s.redoEdit);
  const listRef = useRef<HTMLDivElement>(null);
  // auto-scroll pauses briefly after the user scrolls by hand
  const userScrolledAt = useRef(0);

  const activeId = cues.find(
    (c) => currentTime >= c.start && currentTime < c.end
  )?.id;

  useEffect(() => {
    if (activeId == null) return;
    if (Date.now() - userScrolledAt.current < 3000) return;
    listRef.current
      ?.querySelector(`[data-cue="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800/80 px-3.5 py-1.5">
        <p className="text-xs font-medium text-zinc-400">
          Captions <span className="text-zinc-600">· {cues.length}</span>
        </p>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => undoEdit()}
            title="Undo"
            className="rounded-md p-2 text-zinc-400 active:bg-zinc-800 active:text-zinc-100"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => redoEdit()}
            title="Redo"
            className="rounded-md p-2 text-zinc-400 active:bg-zinc-800 active:text-zinc-100"
          >
            <Redo2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        ref={listRef}
        onTouchStart={() => (userScrolledAt.current = Date.now())}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
      >
        {cues.map((c) => (
          <button
            key={c.id}
            data-cue={c.id}
            onClick={() => seek(c.start + 0.01)}
            className={`flex w-full items-baseline gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
              c.id === activeId ? "bg-violet-500/15" : "active:bg-zinc-800/60"
            }`}
          >
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
              {fmtClock(c.start)}
            </span>
            <span
              className={`text-[15px] leading-5 ${
                c.id === activeId ? "text-zinc-100" : "text-zinc-400"
              }`}
            >
              {c.words.map((w) => w.text).join(" ")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
