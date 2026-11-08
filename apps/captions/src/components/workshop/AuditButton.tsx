import { useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { AUDIT_DEPTHS, type AuditDepth } from "@/lib/workshop";

/** "Check accuracy" with the two depths; disabled until the server has a research key. */
export function AuditButton({
  available,
  busy,
  onAudit,
  className,
  menu = "down",
}: {
  available: boolean;
  busy: boolean;
  onAudit: (depth: AuditDepth) => void;
  className?: string;
  menu?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy || !available}
        className={className ?? "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"}
        title={available ? "Check the facts against sources on the web" : "Accuracy checks need your own AI, or your Perplexity key in Settings → My API keys"}
        aria-expanded={open}
      >
        <ShieldCheck className="h-3.5 w-3.5" /> Check accuracy <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <span className={`absolute z-30 flex w-72 flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ${menu === "up" ? "bottom-full left-0 mb-1" : "right-0 top-full mt-1"}`}>
          {AUDIT_DEPTHS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onAudit(d.id);
              }}
              className="flex flex-col items-start rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              <span className="text-[11px] font-medium text-foreground">{d.label}</span>
              <span className="text-[10px] text-muted-foreground">{d.hint}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
