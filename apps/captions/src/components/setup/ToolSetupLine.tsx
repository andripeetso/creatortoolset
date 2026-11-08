import { useEffect } from "react";
import { readiness, TOOL_NAMES, type Tool } from "@contracts/tools";
import { useMe } from "@/lib/auth";
import { openToolSetup, useSetup } from "@/lib/setup";

/**
 * The one line a tool page keeps while the tool still needs something (8.4): its name, and a Set up link that opens
 * the same checklist as the first-open welcome. Nothing when the tool is ready, or when there is no setup (a guest).
 */
export function ToolSetupLine({ tool }: { tool: Tool }) {
  const me = useMe();
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  useEffect(() => {
    if (me && !view) void load();
  }, [me, view, load]);
  if (!view || readiness(tool, view.have).ready) return null;
  return (
    <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
      <span>{TOOL_NAMES[tool]} still needs a few things.</span>
      <button type="button" className="underline underline-offset-2" onClick={() => openToolSetup(tool)}>
        Set up
      </button>
    </p>
  );
}
