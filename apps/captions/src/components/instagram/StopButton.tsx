import { useState } from "react";
import { cn } from "@/lib/utils";

/** Stop for a Content Analyzer run (a post's analysis, an account's pull, the idea board): off while its request runs, "Could not stop" when it fails. */
export function StopButton({ onStop, className }: { onStop: () => Promise<unknown>; className?: string }) {
  const [state, setState] = useState<"busy" | "failed" | null>(null);
  const stop = async () => {
    setState("busy");
    try {
      await onStop();
      setState(null);
    } catch {
      setState("failed");
    }
  };
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button
        type="button"
        disabled={state === "busy"}
        onClick={() => void stop()}
        className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
      >
        {state === "busy" ? "Stopping" : "Stop"}
      </button>
      {state === "failed" && <span className="text-[11px] text-red-400">Could not stop</span>}
    </span>
  );
}
