import { useState } from "react";
import { Check, CircleHelp, Loader2, X } from "lucide-react";
import type { AssistantConfirm, AssistantView } from "@contracts/assistant";
import { answerConfirm } from "@/lib/assistant";
import { cn } from "@/lib/utils";

/**
 * What the assistant asks before it deletes, publishes or sends something: the question, and Yes / No. Yes does it
 * (the server runs it as the person) and the card then says how it went; No drops it. The card stays in the chat.
 */
export function ConfirmCards({ confirms, onView }: { confirms?: AssistantConfirm[]; onView: (v: AssistantView) => void }) {
  if (!confirms?.length) return null;
  return (
    <ul className="my-1.5 space-y-1.5">
      {confirms.map((q) => (
        <Confirm key={q.id} q={q} onView={onView} />
      ))}
    </ul>
  );
}

function Confirm({ q, onView }: { q: AssistantConfirm; onView: (v: AssistantView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (yes: boolean) => {
    setError(null);
    setBusy(true);
    const r = await answerConfirm(q.id, yes);
    setBusy(false);
    if (r.ok) onView(r.data);
    else setError(r.error);
  };
  const waiting = q.status === "waiting";
  return (
    <li
      className={cn(
        "rounded-xl border bg-background/60 px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
        waiting ? "border-[color-mix(in_srgb,var(--tint)_60%,transparent)]" : "border-border",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-[var(--tint)]">
          <CircleHelp className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{q.question}</p>
          {waiting ? (
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(true)}
                className="rounded-full bg-[var(--tint)] px-3.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] focus-visible:ring-offset-1 disabled:opacity-60"
              >
                Yes
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(false)}
                className="rounded-full border px-3.5 py-1 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] disabled:opacity-60"
              >
                No
              </button>
              {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
            </div>
          ) : (
            <p className="mt-1.5 flex items-start gap-1 text-xs text-muted-foreground">
              {q.status === "done" ? (
                <>
                  <Check className="size-3.5 shrink-0 text-emerald-500" /> Done
                </>
              ) : q.status === "no" ? (
                <>
                  <X className="size-3.5 shrink-0" /> Not done
                </>
              ) : (
                <>
                  <X className="size-3.5 shrink-0 text-destructive" /> <span className="text-destructive">{q.result || "It didn't work."}</span>
                </>
              )}
            </p>
          )}
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </li>
  );
}
