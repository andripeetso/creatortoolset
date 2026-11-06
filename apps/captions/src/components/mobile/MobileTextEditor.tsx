import { useState } from "react";
import { useStudio } from "@/lib/store";

/**
 * Full-screen transcript editor: one caption per line in a plain
 * textarea (robust with mobile keyboards). "Done" commits every line at
 * once through applyTranscript — the store's LCS alignment re-attaches
 * each word to its original timing, so fixing typos, splitting or
 * merging captions all keep the sync. One commit = one undo step.
 */
export function MobileTextEditor({ onClose }: { onClose: () => void }) {
  const cues = useStudio((s) => s.cues);
  const applyTranscript = useStudio((s) => s.applyTranscript);
  const [text, setText] = useState(() =>
    cues.map((c) => c.words.map((w) => w.text).join(" ")).join("\n")
  );

  const done = () => {
    const lines = text
      .split("\n")
      .map((l) => l.trim().split(/\s+/).filter(Boolean));
    applyTranscript(lines);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0b10]">
      <div className="pt-safe flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-[#101014] px-3 pb-2.5">
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm text-zinc-400 active:bg-zinc-800"
        >
          Cancel
        </button>
        <p className="min-w-0 flex-1 text-center text-sm font-medium text-zinc-200">
          Edit transcript
        </p>
        <button
          onClick={done}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white active:bg-violet-500"
        >
          Done
        </button>
      </div>
      <p className="shrink-0 px-4 pt-2.5 text-xs leading-5 text-zinc-500">
        One caption per line. Fix words, split or merge lines — timings are
        kept automatically.
      </p>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoCapitalize="sentences"
        autoCorrect="on"
        className="min-h-0 flex-1 resize-none bg-transparent p-4 text-base leading-7 text-zinc-100 outline-none"
      />
    </div>
  );
}
