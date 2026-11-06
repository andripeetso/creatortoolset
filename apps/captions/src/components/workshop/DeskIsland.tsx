import type { ReactNode } from "react";
import { ISLAND_LABEL, type IslandId } from "@/lib/workshop-desk";

const TONE: Record<IslandId, string> = {
  writing: "bg-[var(--desk-writing)]",
  cowork: "bg-[var(--desk-cowork)]",
  content: "bg-[var(--desk-content)]",
};

const HEADER = "flex min-h-10 shrink-0 items-center border-b border-border";

/** One framed island: a named header (or a custom one). Show/hide and order live in the header chips. */
export function DeskIsland({
  id,
  hint,
  header,
  untitled,
  children,
}: {
  id: IslandId;
  hint?: string;
  header?: ReactNode;
  untitled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col rounded-lg border border-border ${TONE[id]}`}>
      {header ? (
        <div className={HEADER}>
          <div className="flex h-full min-w-0 flex-1 items-center">{header}</div>
        </div>
      ) : untitled ? null : (
        <div className={`${HEADER} gap-2 px-2.5`}>
          <span className="text-[12px] font-medium text-foreground">{ISLAND_LABEL[id]}</span>
          {hint ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={hint}>{hint}</span> : <span className="flex-1" />}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
