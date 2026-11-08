import { useState } from "react";
import { Check, Clock, ShieldQuestion, X } from "lucide-react";
import type { AssistantApproval } from "@contracts/assistant";
import { answerApproval } from "@/lib/assistant";
import { cn } from "@/lib/utils";

/**
 * What the reply asks to do on the user's Mac (a command, a file change, a read outside its folder): what it is in
 * plain words, the exact command or path, and Allow / Deny. Answered, it says so and stays in the chat. The dock's
 * poll brings the server's status; this only shows the click until then.
 */
export function ApprovalCards({ approvals }: { approvals?: AssistantApproval[] }) {
  if (!approvals?.length) return null;
  return (
    <ul className="my-1.5 space-y-1.5">
      {approvals.map((a) => (
        <Approval key={a.id} a={a} />
      ))}
    </ul>
  );
}

function Approval({ a }: { a: AssistantApproval }) {
  const [clicked, setClicked] = useState<"allowed" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = a.status === "waiting" && clicked ? clicked : a.status;
  const waiting = status === "waiting";
  const send = async (allow: boolean) => {
    setError(null);
    setClicked(allow ? "allowed" : "denied");
    const r = await answerApproval(a.id, allow);
    if (!r.ok) {
      setClicked(null);
      setError(r.error);
    }
  };
  return (
    <li
      className={cn(
        "rounded-xl border bg-background/60 px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
        waiting ? "border-[color-mix(in_srgb,var(--tint)_60%,transparent)]" : "border-border",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-[var(--tint)]">
          <ShieldQuestion className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{a.summary}</p>
          {a.detail && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all text-foreground">{a.detail}</pre>
          )}
          {waiting ? (
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => void send(true)}
                className="rounded-full bg-[var(--tint)] px-3.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] focus-visible:ring-offset-1"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => void send(false)}
                className="rounded-full border px-3.5 py-1 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
              >
                Deny
              </button>
            </div>
          ) : (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              {status === "allowed" ? (
                <>
                  <Check className="size-3.5 text-emerald-500" /> Allowed
                </>
              ) : status === "denied" ? (
                <>
                  <X className="size-3.5 text-destructive" /> Denied
                </>
              ) : (
                <>
                  <Clock className="size-3.5" /> Not answered, so not done
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
