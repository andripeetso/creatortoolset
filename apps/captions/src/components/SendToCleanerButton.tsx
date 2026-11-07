import { useState } from "react";
import { Eraser } from "lucide-react";
import { useStudio, isEditorBusy } from "@/lib/store";
import { flushPendingSave } from "@/lib/persist";
import { canUse, useMe } from "@/lib/auth";

export function SendToCleanerButton() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = useStudio(
    (s) =>
      !!s.projectId &&
      !!s.activeClipId &&
      s.serverProjectReady &&
      !isEditorBusy(s) &&
      s.clips.some(
        (c) =>
          c.id === s.activeClipId && c.hasOriginal && c.uploadState === "done",
      ),
  );
  async function send() {
    setBusy(true);
    setError("");
    try {
      await flushPendingSave();
      const state = useStudio.getState();
      if (state.saveState !== "saved" || state.serverConflict)
        throw new Error(
          "Finish saving this project before sending it to Cleaner.",
        );
      const response = await fetch("/api/clean/sources/from-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: state.projectId,
          clipId: state.activeClipId,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not open Cleaner.");
      window.location.assign(`/clean?session=${encodeURIComponent(result.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Cleaner.");
    } finally {
      setBusy(false);
    }
  }
  if (!canUse(me, "clean")) return null;
  return (
    <div className="relative">
      <button
        disabled={!ready || busy}
        onClick={() => void send()}
        title="Edit the uncaptioned source in Video Cleaner, then return with caption timings remapped"
        className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        <Eraser className="h-3.5 w-3.5" />
        {busy ? "Opening…" : "Video Cleaner"}
      </button>
      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-amber-500/30 bg-zinc-900 p-3 text-xs text-amber-300"
        >
          {error}
        </p>
      )}
    </div>
  );
}
