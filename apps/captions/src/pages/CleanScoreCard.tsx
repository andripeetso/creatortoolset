import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ScoreCard({
  label,
  value,
  scale,
  status,
  stale,
  description,
  children,
}: {
  label: string;
  value: string;
  scale: string;
  status: string;
  stale: boolean;
  description: string;
  children?: ReactNode;
}) {
  return (
    <ScoreHelp
      description={description}
      className="min-w-0 rounded-xl border border-zinc-700/60 bg-zinc-950/30 p-3 text-left transition-colors hover:border-violet-400/60 hover:bg-violet-500/10 focus-visible:border-violet-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
    >
      <span className="flex min-h-8 items-start justify-between gap-1 text-[11px] font-medium text-zinc-300">
        {label}
        <Info
          className="mt-0.5 h-3 w-3 shrink-0 text-violet-400"
          aria-hidden="true"
        />
      </span>
      <span
        className={`mt-2 block text-xl font-semibold tabular-nums xl:text-2xl ${stale ? "text-amber-200" : "text-zinc-100"}`}
      >
        {value}
      </span>
      <span className="mt-1 block text-[10px] leading-relaxed text-zinc-400">
        {scale}
      </span>
      <span
        className={`mt-2 block text-[10px] leading-relaxed ${stale ? "text-amber-300" : "text-zinc-400"}`}
      >
        {status}
      </span>
      {children && (
        <span className="mt-2 block text-[10px] leading-relaxed text-zinc-400">
          {children}
        </span>
      )}
    </ScoreHelp>
  );
}

export function ScoreHelp({
  description,
  className,
  children,
}: {
  description: string;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={className}
          onClick={() => setOpen((value) => !value)}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="max-w-[min(20rem,calc(100vw-2rem))] leading-relaxed"
      >
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
