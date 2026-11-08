import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { CalendarClock, Captions, Check, Clapperboard, Film, Link2, Loader2, NotebookText, PenLine, X, type LucideIcon } from "lucide-react";
import type { AssistantWork } from "@contracts/assistant";
import { cn } from "@/lib/utils";

const ICONS: Record<AssistantWork["kind"], LucideIcon> = { workshop: PenLine, edit: Clapperboard, review: Film, automation: CalendarClock, link: Link2, notes: NotebookText, captions: Captions };

/** What the reply started or opened (a Workshop session, an edit, a link): a card each, the whole card opens it. */
export function WorkCards({ work, className }: { work?: AssistantWork[]; className?: string }) {
  const navigate = useNavigate();
  if (!work?.length) return null;
  return (
    <ul className={cn("my-1.5 space-y-1.5", className)}>
      {work.map((w) => {
        const Icon = ICONS[w.kind] ?? Link2;
        const external = /^https?:\/\//.test(w.href);
        return (
          <li key={w.id} className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300">
            <a
              href={w.href}
              {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
              onClick={(e) => {
                // in the app: move there with the dock still open (a modified click still opens a tab)
                if (external || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(w.href);
              }}
              className="flex items-center gap-2.5 rounded-xl border border-border bg-background/60 px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
              title={external ? "Open in a new tab" : "Open"}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{w.title}</span>
                {w.detail && <span className="block truncate text-xs text-muted-foreground">{w.detail}</span>}
              </span>
              <Status status={w.status} />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function Status({ status }: { status: AssistantWork["status"] }) {
  if (status === "running") return <Loader2 className="size-4 shrink-0 text-[var(--tint)] motion-safe:animate-spin" aria-label="Running" />;
  if (status === "failed") return <X className="size-4 shrink-0 text-destructive" aria-label="Failed" />;
  return <Check className="size-4 shrink-0 text-emerald-500" aria-label="Done" />;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** "Working · 1:23" once a reply has taken more than ten seconds, so a long wait never looks frozen. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // the server's clock and this one can differ: never below zero
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 10) return null;
  return (
    <p className="mb-1 text-xs text-muted-foreground tabular-nums motion-safe:animate-in motion-safe:fade-in">
      Working · {clock(s)}
    </p>
  );
}
