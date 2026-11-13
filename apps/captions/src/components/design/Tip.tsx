import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** What a control is, shown beside it a moment after the pointer rests on it, with its key when it has one. The app's own tooltip, never the system's. */
export function Tip({ label, keys, side = "top", children }: { label: string; keys?: string; side?: "top" | "bottom" | "left" | "right"; children: ReactElement }) {
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6} className="px-2 py-1 text-[11px]">
        {label}
        {keys && <span className="ml-2 opacity-60">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
