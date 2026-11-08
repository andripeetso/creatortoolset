import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { Have } from "@contracts/tools";
import type { WorkPrefs } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/workshop/CopyButton";
import { cn } from "@/lib/utils";
import { AppArt, BothArt, ChatArt } from "./HowArt";

type Talk = WorkPrefs["talk"];

const WAYS: Array<{ talk: Talk; name: string; what: string; art: () => React.JSX.Element }> = [
  { talk: "app", name: "In the app", what: "Plan, edit and review here, with the assistant beside you.", art: AppArt },
  { talk: "chat", name: "In my own AI", what: "Keep working in Claude Code or Codex. Creator Toolset works in the background.", art: ChatArt },
  { talk: "both", name: "Both", what: "Ask from your own AI, and open the app to see and touch the work.", art: BothArt },
];

/** Setup's first question: where they talk to the AI (work-prefs `talk`). Three cards side by side, each a picture of it. */
export function HowPicker({ value, onPick }: { value: Talk; onPick: (t: Talk) => void }) {
  return (
    <div role="radiogroup" aria-label="How do you want to work?" className="grid gap-4 sm:grid-cols-3">
      {WAYS.map((w) => {
        const on = w.talk === value;
        return (
          <button
            key={w.talk}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(w.talk)}
            className={cn(
              "group relative flex flex-col overflow-hidden rounded-2xl border text-center outline-none transition-[border-color,box-shadow,transform] duration-200",
              "focus-visible:ring-2 focus-visible:ring-[var(--tint)] motion-safe:hover:-translate-y-0.5",
              on ? "border-[var(--tint)] shadow-[0_0_0_1px_var(--tint),0_12px_32px_-12px_color-mix(in_srgb,var(--tint)_45%,transparent)]" : "border-border/70 hover:border-foreground/25",
            )}
          >
            <span
              className={cn(
                "flex aspect-[16/9] items-center justify-center border-b px-6 py-4 transition-colors",
                on ? "border-[color-mix(in_srgb,var(--tint)_35%,transparent)] bg-[color-mix(in_srgb,var(--tint)_10%,transparent)]" : "border-border/60 bg-muted/40",
              )}
            >
              <w.art />
            </span>
            <span className={cn("flex flex-1 flex-col items-center px-4 pb-4 pt-3.5", on && "bg-[color-mix(in_srgb,var(--tint)_4%,transparent)]")}>
              <span className="text-[15px] font-semibold text-foreground">{w.name}</span>
              <span className="mt-1 max-w-[16rem] text-[13px] leading-snug text-muted-foreground">{w.what}</span>
            </span>
            <span
              aria-hidden
              className={cn(
                "absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border transition-all",
                on ? "border-[var(--tint)] bg-[var(--tint)] text-white" : "border-foreground/20 bg-background/80",
              )}
            >
              {on && <Check className="size-3" strokeWidth={3} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

async function post(run: boolean): Promise<Reply> {
  const r = await fetch("/api/setup/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run }),
  }).catch(() => null);
  return ((await r?.json().catch(() => null)) ?? {
    error: "Couldn't reach the server",
  }) as Reply;
}

type Reply = {
  ok?: true;
  added?: string[];
  failed?: string[];
  command?: string;
  error?: string;
};

/**
 * Connect their own AI to this Mac's server (api/setup.ts /connect): one button adds it to every AI CLI found here
 * (one key for all), a command to paste when there's none, and a status that turns to ✓ once a call with the new key arrives (`mcp` in setup's `have`).
 */
export function ConnectStep({ have }: { have: readonly Have[] }) {
  const [info, setInfo] = useState<{
    clis: Array<{ driver: "claude" | "codex" }>;
    hasKey: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/setup/connect")
      .then((r) => (r.ok ? r.json() : { clis: [], hasKey: false }))
      .then(setInfo)
      .catch(() => setInfo({ clis: [], hasKey: false }));
  }, []);
  const act = async (run: boolean) => {
    setBusy(true);
    setError("");
    const r = await post(run);
    setBusy(false);
    if (r.error) return setError(r.error);
    if (r.ok) (setAdded(r.added ?? []), setFailed(r.failed ?? []));
    if (r.command) setCommand(r.command);
    setInfo((i) => i && { ...i, hasKey: true });
  };
  const connected = have.includes("mcp");

  return (
    <div className="max-w-2xl space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        {!!info?.clis.length && (
          <Button size="sm" disabled={busy} onClick={() => void act(true)}>
            {added.length ? <Check /> : null} Connect{" "}
            {info.clis
              .map((c) => (c.driver === "claude" ? "Claude Code" : "Codex"))
              .join(" and ")}
          </Button>
        )}
        {info && !info.clis.length && (
          <p className="text-muted-foreground">
            No Claude Code or Codex found on this Mac. Paste the command below
            once you have one.
          </p>
        )}
      </div>
      {!!added.length && (
        <p className="text-xs text-muted-foreground">
          Added to {added.join(" and ")}.
        </p>
      )}
      {[error, ...failed].filter(Boolean).map((f) => (
        <p key={f} className="text-xs text-rose-500">
          {f}
        </p>
      ))}

      {/* one Full key per account: a second way to make one would cut off the first, so the command is only for a Mac with no button */}
      {info && !info.clis.length && (
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">
            Or paste this into a terminal:
          </p>
          {command ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {command.replace(/ctk_[a-f0-9]+/, (k) => `ctk_…${k.slice(-4)}`)}
              </code>
              <CopyButton
                text={() => command}
                label="Copy"
                title="Copy the command"
                className="flex items-center gap-1 rounded border px-2 py-1 text-xs"
              />
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={busy}
              onClick={() => void act(false)}
            >
              Make the command
            </Button>
          )}
        </div>
      )}

      <p className="flex items-center gap-2">
        {connected ? (
          <Check className="h-4 w-4 text-emerald-500" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {connected ? "Your AI is connected." : "Waiting for your AI to connect"}
      </p>
      {connected && (
        <p className="font-medium">Ask your AI: set up my first project.</p>
      )}
      <p className="text-xs text-muted-foreground">
        ChatGPT and claude.ai on the web can't reach this Mac; they need the
        hosted version.
      </p>
    </div>
  );
}
