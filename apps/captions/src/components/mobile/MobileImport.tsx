import { useEffect, useState } from "react";
import { Captions, Film, RotateCcw, ScrollText } from "lucide-react";
import {
  persistAutoCadence,
  storedAutoCadence,
} from "@/lib/cadence-preference";
import { aiStatus } from "@/lib/refine";
import { MAX_SCRIPT_CHARS } from "@/lib/script-check";

/**
 * Step 1: pick a single video from the camera roll / files, optionally
 * with the script it was filmed from (checked against the transcript).
 */
export function MobileImport({
  onPick,
  hasCurrent,
  onContinue,
}: {
  onPick: (file: File, script: string) => void;
  hasCurrent: boolean;
  onContinue: () => void;
}) {
  const [autoCadence, setAutoCadence] = useState(storedAutoCadence);
  const [script, setScript] = useState("");
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptCheck, setScriptCheck] = useState(false);
  useEffect(() => {
    aiStatus().then((s) => setScriptCheck(s.available && s.allowed));
  }, []);

  return (
    <div className="pb-safe flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-600">
        <Captions className="h-8 w-8 text-white" />
      </div>
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Add captions</h1>
        <p className="mt-2 max-w-xs text-sm leading-6 text-zinc-400">
          Pick a video. It&apos;s transcribed in the cloud, you fix and style
          the captions, and export a ready-to-post MP4.
        </p>
      </div>

      {scriptCheck && scriptOpen && (
        <div className="w-full max-w-xs">
          <label
            htmlFor="mobile-script"
            className="mb-1.5 flex items-center gap-1.5 text-sm text-zinc-200"
          >
            <ScrollText className="h-4 w-4 text-zinc-400" /> Original script
          </label>
          <textarea
            id="mobile-script"
            autoFocus
            value={script}
            onChange={(e) => setScript(e.target.value)}
            maxLength={MAX_SCRIPT_CHARS}
            rows={5}
            placeholder="Paste the script you filmed from. AI uses it to fix mis-heard names and words."
            className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-3 text-base leading-6 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
          />
        </div>
      )}

      <label className="flex w-full max-w-xs cursor-pointer items-center justify-center gap-2 rounded-2xl bg-violet-600 py-4 text-base font-semibold text-white active:bg-violet-500">
        <Film className="h-5 w-5" /> Choose video
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f, script);
            e.target.value = "";
          }}
        />
      </label>

      {scriptCheck && !scriptOpen && (
        <button
          onClick={() => setScriptOpen(true)}
          className="flex w-full max-w-xs items-center justify-center gap-2 rounded-xl border border-zinc-800 py-3 text-sm text-zinc-300 active:bg-zinc-900"
        >
          <ScrollText className="h-4 w-4" /> Add the script first (optional)
        </button>
      )}

      <label className="flex w-full max-w-xs cursor-pointer items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-3">
        <input
          type="checkbox"
          checked={autoCadence}
          onChange={(e) => {
            const enabled = e.currentTarget.checked;
            setAutoCadence(enabled);
            persistAutoCadence(enabled);
          }}
          className="mt-0.5 h-4 w-4 shrink-0 accent-violet-500"
        />
        <span>
          <span className="block text-sm text-zinc-200">
            Match cadence automatically
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
            Turn off to edit and position captions before running cadence.
          </span>
        </span>
      </label>

      {hasCurrent && (
        <button
          onClick={onContinue}
          className="flex items-center gap-1.5 text-sm text-zinc-400 active:text-zinc-200"
        >
          <RotateCcw className="h-4 w-4" /> Continue current project
        </button>
      )}
    </div>
  );
}
