import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { confirmDiscardUnsavedProject } from "@/lib/persistence-guard";
import { captionThisVideo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CaptionArt } from "./HowArt";

/**
 * Setup's last screen, "Try it": one drop target that is also the file chooser (the whole card is the input's label;
 * the drop itself is taken from the whole window).
 * A video starts its first caption job and `onStart` closes setup; a file that can't be captioned is said so here.
 */
export function TryStep({ onStart }: { onStart: () => void | Promise<void> }) {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(false);
  const take = async (file: File | undefined) => {
    if (!file || !confirmDiscardUnsavedProject("Start a new project")) return;
    // looked at before setup closes: a file with only a video's name, or a clip with no sound, would end in a failed job
    const { hasSoundTrack } = await import("@/lib/audio-decode");
    if ((await hasSoundTrack(file)) && captionThisVideo(file)) void onStart();
    else setRefused(true);
  };
  // a drop anywhere in the window counts: one that misses the card would otherwise make the browser open the file
  // in place of the app
  useEffect(() => {
    const allow = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      void take(e.dataTransfer?.files[0]);
    };
    window.addEventListener("dragover", allow);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", allow);
      window.removeEventListener("drop", drop);
    };
  });
  return (
    <label
      onDragOver={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      className={cn(
        "group flex h-full min-h-56 cursor-pointer flex-col items-center justify-center gap-5 rounded-2xl border-2 border-dashed px-6 py-6 text-center outline-none transition-[border-color,background-color] duration-200",
        "focus-within:ring-2 focus-within:ring-[var(--tint)]",
        over
          ? "border-[var(--tint)] bg-[color-mix(in_srgb,var(--tint)_12%,transparent)]"
          : "border-[color-mix(in_srgb,var(--tint)_40%,transparent)] bg-[color-mix(in_srgb,var(--tint)_5%,transparent)] hover:border-[var(--tint)] hover:bg-[color-mix(in_srgb,var(--tint)_8%,transparent)]",
      )}
    >
      <input
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = ""; // the same file can be picked again
        }}
      />
      <span className={cn("block w-full max-w-[19rem] transition-transform duration-200 motion-safe:group-hover:-translate-y-0.5", over && "motion-safe:-translate-y-0.5")}>
        <CaptionArt />
      </span>
      <span className="space-y-3">
        <span className="block text-lg font-semibold tracking-tight text-foreground">{refused ? "That file can't be captioned. Try a video with sound" : "Drop a video here"}</span>
        <span className="inline-flex items-center gap-2 rounded-full bg-[var(--tint)] px-4 py-2 text-sm font-medium text-white transition group-hover:brightness-110">
          <Upload className="size-4" aria-hidden />
          Choose a video
        </span>
      </span>
    </label>
  );
}
