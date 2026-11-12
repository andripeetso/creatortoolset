import { useState } from "react";
import { ChevronDown, Library, Loader2 } from "lucide-react";
import { useStudio, isEditorBusy, clipRenderData } from "@/lib/store";
import { flushPendingSave } from "@/lib/persist";
import { useMe } from "@/lib/auth";
import { buildAss } from "@/lib/ass";
import { exportBase, exportName } from "@/lib/export-request";
import { batchExports, startExport } from "@/lib/exports";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * One click from Caption Studio to Finals: renders the captioned video in the
 * cloud (the Export dialog's defaults: native engine, H.264, the source's size)
 * and the server files it in Finals, in the owner's Media Library, when the
 * render is done. The export tray shows the progress and the download. With
 * several clips it sends this one, the selected ones or all, their files
 * downloading as one ZIP. Renders below 1080p are refused by the server.
 */
export function SendToFinalsButton() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const clips = useStudio((s) => s.clips);
  const activeClipId = useStudio((s) => s.activeClipId);
  const selectedIds = useStudio((s) => s.selectedClipIds);
  const selected = selectedIds.filter((id) => clips.some((c) => c.id === id));
  const ready = useStudio(
    (s) => !!s.projectId && !!s.activeClipId && s.serverProjectReady && !isEditorBusy(s),
  );
  const activeReady = useStudio(
    (s) =>
      (s.cues.length > 0 || s.texts.length > 0) &&
      s.clips.some((c) => c.id === s.activeClipId && c.hasOriginal && c.uploadState === "done"),
  );
  async function send(ids: string[]) {
    setBusy(true);
    setNote("");
    try {
      await flushPendingSave();
      const s = useStudio.getState();
      if (!s.projectId) throw new Error("Open a clip first.");
      const project = exportBase(s.fileName);
      const started: string[] = [];
      const skipped: string[] = [];
      for (const id of ids) {
        const clip = s.clips.find((c) => c.id === id);
        const d = clipRenderData(id);
        if (!clip) continue;
        if (!d || (!d.cues.length && !d.texts.length)) {
          skipped.push(`${clip.name} (no captions)`);
          continue;
        }
        if (!clip.hasOriginal || clip.uploadState !== "done") {
          skipped.push(`${clip.name} (video still uploading)`);
          continue;
        }
        const name = exportName(s.fileName, clip.name);
        try {
          const job = await startExport({
            kind: "burn",
            format: "h264",
            name,
            duration: d.duration,
            projectId: s.projectId,
            clipId: id,
            width: d.width,
            height: d.height,
            fps: s.fps,
            engine: "native",
            ass: buildAss(d.cues, d.style, d.width, d.height, d.posSegments, d.texts),
            finals: true,
          });
          started.push(job.id);
        } catch (e) {
          skipped.push(`${clip.name} (${e instanceof Error ? e.message : "could not start"})`);
        }
      }
      batchExports(started, project || "finals");
      setNote(
        [
          started.length === 1
            ? "Rendering with captions; it goes to Finals by itself when it's done (see the export tray)."
            : started.length
              ? `Rendering ${started.length} with captions; each goes to Finals by itself when it's done, and the files download as one ZIP.`
              : "",
          skipped.length ? `Not sent: ${skipped.join(", ")}.` : "",
        ].filter(Boolean).join(" "),
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not start the render.");
    } finally {
      setBusy(false);
    }
  }
  if (!me) return null;
  const cls =
    "flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40";
  const icon = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Library className="h-3.5 w-3.5" />;
  const activeName = clips.find((c) => c.id === activeClipId)?.name ?? "this clip";
  return (
    <div className="relative">
      {clips.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button disabled={!ready || busy} className={cls}
              title="Render with captions in the cloud and put it in Finals">
              {icon} Send to Finals <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!activeReady} onClick={() => void send([activeClipId!])}>
              This clip ({activeName.replace(/\.[^.]+$/, "")})
            </DropdownMenuItem>
            {selected.length > 1 && (
              <DropdownMenuItem onClick={() => void send(selected)}>
                The {selected.length} selected clips
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => void send(clips.map((c) => c.id))}>
              All {clips.length} clips
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          disabled={!ready || !activeReady || busy}
          onClick={() => void send([activeClipId!])}
          title="Render with captions in the cloud and put it in Finals"
          className={cls}
        >
          {icon} Send to Finals
        </button>
      )}
      {note && (
        <p role="status" onClick={() => setNote("")}
          className="absolute right-0 top-full z-50 mt-2 w-72 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300">
          {note}
        </p>
      )}
    </div>
  );
}
