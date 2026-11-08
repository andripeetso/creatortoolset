import { useEffect, useRef, useState } from "react";
import { ScrollText, Sparkles, X } from "lucide-react";
import { isEditorBusy, useStudio } from "@/lib/store";
import { aiStatus, type AiStatus } from "@/lib/refine";
import { MAX_SCRIPT_CHARS } from "@/lib/script-check";

/**
 * The script the project's video was filmed from. Saved with the project;
 * every fresh transcript is checked against it, and "Save & check" runs
 * the check on the active clip's transcript now. Closing without saving
 * (backdrop / Escape / ×) drops the edits.
 */
export function ScriptDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState(() => useStudio.getState().script);
  const hasWords = useStudio((s) => s.cues.length > 0);
  const busy = useStudio(isEditorBusy);
  const [ai, setAi] = useState<AiStatus | null>(null);
  useEffect(() => {
    aiStatus().then(setAi);
  }, []);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const save = (check: boolean) => {
    const st = useStudio.getState();
    st.setScript(text);
    onClose();
    if (check) void st.checkScript();
  };

  const canCheck = !!ai?.available && !!ai.allowed;
  const checkBlocked = !text.trim()
    ? "Paste the script first"
    : !hasWords
      ? "Transcribe the clip first"
      : busy
        ? "Wait for the current processing to finish"
        : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[560px] max-w-[92vw] flex-col rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <ScrollText className="h-4 w-4 text-violet-400" /> Original script
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs leading-5 text-zinc-400">
          Paste the script you filmed from. After transcription, AI reads the
          transcript against it and fixes words the engine mis-heard: names,
          brand words, uncommon terms. The video doesn&apos;t have to match
          the script. Anything you said differently stays as you said it.
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_SCRIPT_CHARS}
          rows={14}
          spellCheck={false}
          placeholder="Paste your script here…"
          className="min-h-[10rem] w-full flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-[13px] leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
        />
        <p className="mt-1 text-right text-[10px] tabular-nums text-zinc-600">
          {text.length.toLocaleString()} / {MAX_SCRIPT_CHARS.toLocaleString()}
        </p>
        {ai && !canCheck && (
          <p className="mt-1 text-[11px] leading-4 text-amber-400/80">
            {ai.available
              ? "The script check is locked for your account — ask the admin. The script is still saved with the project."
              : "The script check needs an AI key on the server. The script is still saved with the project."}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          {canCheck && (
            <button
              onClick={() => save(true)}
              disabled={!!checkBlocked}
              title={checkBlocked ?? "Save, then fix mis-heard words in this clip's transcript"}
              className="flex items-center gap-2 h-9 rounded-md bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40 disabled:hover:bg-violet-600"
            >
              <Sparkles className="h-4 w-4" /> Save &amp; check transcript
            </button>
          )}
          <button
            onClick={() => save(false)}
            className={
              canCheck
                ? "rounded-md border border-zinc-700 px-3.5 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
                : "h-9 rounded-md bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500"
            }
          >
            Save
          </button>
          <button
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
