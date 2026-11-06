import { useEffect, useRef, useState } from "react";
import {
  Check,
  CloudUpload,
  FileVideo,
  Loader2,
  ScrollText,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useStudio, getClipSnapshot } from "@/lib/store";
import { fmtClock } from "@/lib/ass";
import { isGuest, useViewedMe } from "@/lib/auth";
import {
  persistAutoCadence,
  storedAutoCadence,
} from "@/lib/cadence-preference";
import { aiStatus } from "@/lib/refine";
import { MAX_SCRIPT_CHARS } from "@/lib/script-check";
import { EnginePicker } from "./EnginePicker";
import { FpsSelect } from "./FpsSelect";

/**
 * Shown right after videos are imported, while the uploads and the
 * server's proxy transcodes run in the background. Lets the user name
 * the project and kick off transcription immediately — transcription
 * runs client-side off the in-memory files, so it doesn't wait for the
 * uploads. Closing (skip / backdrop / Escape) still commits the name.
 * With several clips, "Transcribe now" batches the whole pool with the
 * chosen engine. The optional script is what the video was filmed from:
 * each transcript is checked against it (AI) before cadence.
 */

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** "clip.final.MP4" → "clip.final" — only a real extension is dropped. */
const stripExt = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, "");

function UploadStatus() {
  const clips = useStudio((s) => s.clips);
  const me = useViewedMe();

  if (isGuest(me)) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-400/80">
        <TriangleAlert className="h-3 w-3 shrink-0" /> Guest mode — this project
        stays in your browser and is gone when the tab closes.
      </p>
    );
  }
  const uploading = clips.filter((c) => c.uploadState === "uploading");
  const processing = clips.filter((c) => c.uploadState === "processing");
  const failed = clips.filter((c) => c.uploadState === "error");
  const pending = clips.filter((c) => c.uploadState === "local");
  const done = clips.length - uploading.length - processing.length - failed.length - pending.length;

  if (failed.length > 0 && uploading.length === 0 && processing.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-400">
        <TriangleAlert className="h-3 w-3 shrink-0" />
        {failed.length === 1
          ? "One clip failed to upload — retry it from the clip bar."
          : `${failed.length} clips failed to upload — retry them from the clip bar.`}
      </p>
    );
  }
  if (uploading.length > 0 || processing.length > 0 || pending.length > 0) {
    const active = uploading[0];
    const pct = active ? active.uploadPct : 0;
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-400">
          <span className="flex items-center gap-1.5">
            {processing.length > 0 && uploading.length === 0 ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Preparing editing
                previews…
              </>
            ) : (
              <>
                <CloudUpload className="h-3 w-3 animate-pulse" /> Uploading{" "}
                {clips.length === 1 ? "video" : `clip ${done + 1} of ${clips.length}`} in
                the background…
              </>
            )}
          </span>
          {uploading.length > 0 && <span>{pct}%</span>}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-violet-500 transition-[width] duration-300"
            style={{ width: `${clips.length > 1 ? Math.round((done / clips.length) * 100) : pct}%` }}
          />
        </div>
      </div>
    );
  }
  if (clips.length > 0) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <Check className="h-3 w-3 text-emerald-500" /> Saved to your projects
      </p>
    );
  }
  return null;
}

export function ProjectSetupDialog() {
  const duration = useStudio((s) => s.duration);
  const sourceWidth = useStudio((s) => s.sourceWidth);
  const sourceHeight = useStudio((s) => s.sourceHeight);
  // count and names only (strings, not the clip list): upload progress
  // re-renders UploadStatus, never the form's inputs
  const clipCount = useStudio((s) => s.clips.length);
  const clipNames = useStudio((s) => s.clips.map((c) => c.name).join(", "));
  const batch = clipCount > 1;

  // snapshot the File handles' details — they're released once the
  // server proxies take over, which can happen while the dialog is open
  const [file] = useState(() => {
    const s = useStudio.getState();
    return {
      name: s.clips[0]?.name ?? s.fileName,
      count: s.clips.length,
      size: s.clips.reduce(
        (a, c) => a + (getClipSnapshot(c.id)?.file?.size ?? 0),
        0
      ),
    };
  });
  const [name, setName] = useState(() => stripExt(useStudio.getState().fileName));
  const [autoCadence, setAutoCadence] = useState(storedAutoCadence);
  const [script, setScript] = useState(() => useStudio.getState().script);
  // the check needs the AI pass; locked accounts don't get the field
  const [scriptCheck, setScriptCheck] = useState(false);
  useEffect(() => {
    aiStatus().then((s) => setScriptCheck(s.available && s.allowed));
  }, []);

  const close = (transcribe: boolean) => {
    const st = useStudio.getState();
    st.setFileName(name);
    st.setScript(script);
    st.setAutoCadence(autoCadence);
    persistAutoCadence(autoCadence);
    st.dismissSetup();
    if (transcribe) st.transcribeAll();
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  // Escape = keep the name, transcribe later (capture: outranks the
  // player's own Escape handling while the dialog is up)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={() => close(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] max-w-[92vw] rounded-2xl border border-zinc-700 bg-[#16161c] p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-600/20">
            <FileVideo className="h-5 w-5 text-violet-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">
              Set up your project
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {batch
                ? `${clipCount} clips are saving in the background — name the project and caption them all with the same settings.`
                : "Your video is already saving in the background — name the project and choose how to caption it."}
            </p>
          </div>
        </div>

        {/* file details */}
        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
          <p className="truncate text-xs text-zinc-300" title={clipNames}>
            {batch
              ? `${file.count} clips · ${clipNames.slice(0, 80)}${clipNames.length > 80 ? "…" : ""}`
              : file.name}
          </p>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
            <span className="min-w-0 truncate">
              {file.size > 0 && <>{fmtSize(file.size)} · </>}
              {batch
                ? "one pool, one look"
                : duration > 0
                  ? fmtClock(duration)
                  : "reading length…"}
              {!batch && (
                <>
                  {" · "}
                  {sourceWidth > 0 ? `${sourceWidth}×${sourceHeight}` : "reading resolution…"}
                </>
              )}
            </span>
            {/* the detected rate lands here once the upload is probed —
                editable now for the rare clip that needs correcting */}
            <label className="flex shrink-0 items-center gap-1.5">
              FPS
              <FpsSelect className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none" />
            </label>
          </div>
        </div>

        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Project name
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") close(true);
          }}
          maxLength={120}
          placeholder={stripExt(file.name)}
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
        />

        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Caption engine
        </label>
        <EnginePicker className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500" />

        {scriptCheck && (
          <>
            <label
              htmlFor="setup-script"
              className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500"
            >
              <ScrollText className="h-3 w-3" /> Original script
              <span className="normal-case tracking-normal text-zinc-600">
                optional
              </span>
            </label>
            <textarea
              id="setup-script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              maxLength={MAX_SCRIPT_CHARS}
              rows={3}
              spellCheck={false}
              placeholder="Paste the script you filmed from. AI uses it to fix mis-heard names and words. It doesn't have to match the video."
              className="mb-3 max-h-60 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
            />
          </>
        )}

        <label className="mb-5 flex cursor-pointer items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
          <input
            type="checkbox"
            checked={autoCadence}
            onChange={(e) => setAutoCadence(e.currentTarget.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-violet-500"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-zinc-200">
              Match cadence after transcription
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
              Turn this off to start editing and position captions first. Your
              choice is remembered on this device.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-2">
          <button
            onClick={() => close(true)}
            className="flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
          >
            <Sparkles className="h-4 w-4" />{" "}
            {batch ? `Transcribe all ${clipCount} clips` : "Transcribe now"}
          </button>
          <button
            onClick={() => close(false)}
            className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            I'll transcribe later
          </button>
        </div>

        <div className="mt-4 border-t border-zinc-800 pt-3">
          <UploadStatus />
        </div>
      </div>
    </div>
  );
}
