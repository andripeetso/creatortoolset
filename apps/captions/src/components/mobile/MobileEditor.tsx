import { useEffect, useState } from "react";
import { Check, Download, Loader2, Palette, PencilLine, Sparkles, TriangleAlert } from "lucide-react";
import { isEditorBusy, narrowerThanMatched, useStudio } from "@/lib/store";
import { aiStatus, type AiStatus } from "@/lib/refine";
import { FONT_OPTIONS, fontWeightFor } from "@/lib/types";
import { MobilePlayer } from "./MobilePlayer";
import { MobileTranscript } from "./MobileTranscript";
import { MobileTextEditor } from "./MobileTextEditor";
import { MobileStyleSheet } from "./MobileStyleSheet";

/**
 * Step 3: edit. Player on top (fixed share of the screen), the caption
 * list fills the rest, and the action bar opens styling, the transcript
 * editor, the cadence re-match, or the export step.
 */
export function MobileEditor({ onExport }: { onExport: () => void }) {
  const [styleOpen, setStyleOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const cues = useStudio((s) => s.cues);
  const refining = useStudio((s) => s.refining);
  const editorBusy = useStudio(isEditorBusy);
  const refineCues = useStudio((s) => s.refineCues);
  const fitSplits = useStudio((s) => s.fitSplits);
  const cadenceApplied = useStudio((s) => s.cadenceApplied);
  const dirty = useStudio((s) => s.cadenceDirty);
  const refineError = useStudio((s) => s.refineError);
  const [ai, setAi] = useState<AiStatus | null>(null);
  useEffect(() => {
    void aiStatus().then(setAi);
  }, []);
  // …or the box got narrower than the match planned its breaks for
  const narrower = useStudio(narrowerThanMatched);
  const rematch = !cadenceApplied || dirty || narrower;

  // warm every caption font up front — same reasoning as the desktop
  // editor: avoid painting in a fallback face and swapping later
  useEffect(() => {
    for (const f of FONT_OPTIONS) {
      const w = fontWeightFor(f.family);
      void document.fonts.load(`${w} 16px "${f.family}"`);
    }
  }, []);

  return (
    <div
      aria-busy={editorBusy}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div className="h-[42dvh] shrink-0">
        <MobilePlayer />
      </div>

      <MobileTranscript />

      {refineError && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] leading-5 text-red-300"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{refineError}</span>
        </div>
      )}

      <div className="pb-safe flex shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-925 px-3 pb-2 pt-2">
        <button
          onClick={() => setStyleOpen(true)}
          disabled={editorBusy}
          className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-zinc-300 active:bg-zinc-800 disabled:opacity-40"
        >
          <Palette className="h-5 w-5" />
          <span className="text-[10px]">Style</span>
        </button>
        <button
          onClick={() => setTextOpen(true)}
          disabled={cues.length === 0 || editorBusy}
          className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-zinc-300 active:bg-zinc-800 disabled:opacity-40"
        >
          <PencilLine className="h-5 w-5" />
          <span className="text-[10px]">Edit transcript</span>
        </button>
        {ai?.available && (
          <button
            onClick={() =>
              cadenceApplied && !dirty && narrower ? fitSplits() : refineCues()
            }
            disabled={
              cues.length === 0 || editorBusy || !ai.allowed || !rematch
            }
            className={`flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl disabled:opacity-40 ${
              rematch && !refining
                ? "bg-violet-600/15 text-violet-300 active:bg-violet-600/25"
                : "text-zinc-300 active:bg-zinc-800"
            }`}
          >
            {refining ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : rematch ? (
              <Sparkles className="h-5 w-5" />
            ) : (
              <Check className="h-5 w-5" />
            )}
            <span className="text-[10px]">
              {refining ? "Matching…" : rematch ? "Re-match" : "Cadence ✓"}
            </span>
          </button>
        )}
        <button
          onClick={onExport}
          disabled={cues.length === 0 || editorBusy}
          className="flex h-12 flex-[1.4] flex-col items-center justify-center gap-0.5 rounded-xl bg-violet-600 text-white active:bg-violet-500 disabled:opacity-40"
        >
          <Download className="h-5 w-5" />
          <span className="text-[10px] font-semibold">Export</span>
        </button>
      </div>

      {editorBusy && (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-30 cursor-wait bg-zinc-950/45"
        />
      )}

      {styleOpen && <MobileStyleSheet onClose={() => setStyleOpen(false)} />}
      {textOpen && <MobileTextEditor onClose={() => setTextOpen(false)} />}
    </div>
  );
}
