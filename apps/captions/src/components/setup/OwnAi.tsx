import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { Have } from "@contracts/tools";
import type { WorkPrefs } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/workshop/CopyButton";
import { cn } from "@/lib/utils";

type Talk = WorkPrefs["talk"];

const WAYS: Array<{ talk: Talk; name: string; what: string }> = [
  {
    talk: "app",
    name: "In the app",
    what: "Chat, review and edit here, in one window.",
  },
  {
    talk: "chat",
    name: "In my own AI",
    what: "Keep using Claude or Codex. Creator Toolset works in the background.",
  },
  {
    talk: "both",
    name: "Both",
    what: "Ask from your own AI and open the app when you want to see the work.",
  },
];

/** Setup's first question: where they talk to the AI (work-prefs `talk`). A card saves the answer and goes on. */
export function HowPicker({
  value,
  onPick,
}: {
  value: Talk;
  onPick: (t: Talk) => void;
}) {
  return (
    <div>
      <h3 className="mb-3 text-base font-medium">
        How do you want to use Creator Toolset?
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        {WAYS.map((w) => (
          <button
            key={w.talk}
            type="button"
            onClick={() => onPick(w.talk)}
            className={cn(
              "rounded-lg border p-4 text-left hover:border-violet-500",
              w.talk === value
                ? "border-violet-500 bg-violet-500/10"
                : "border-border",
            )}
          >
            <p className="text-sm font-medium">{w.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{w.what}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

async function post(
  run: boolean,
): Promise<{ ok?: true; command?: string; error?: string }> {
  const r = await fetch("/api/setup/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run }),
  }).catch(() => null);
  return ((await r?.json().catch(() => null)) ?? {
    error: "Couldn't reach the server",
  }) as { ok?: true; command?: string; error?: string };
}

/**
 * Connect their own AI to this Mac's server (api/setup.ts /connect): one button per AI CLI found here, a command to
 * paste instead, and a status that turns to ✓ once a call with the new key arrives (`mcp` in setup's `have`).
 */
export function ConnectStep({ have }: { have: readonly Have[] }) {
  const [info, setInfo] = useState<{
    clis: Array<{ driver: "claude" | "codex" }>;
    hasKey: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
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
    if (r.ok) setAdded(true);
    if (r.command) setCommand(r.command);
    setInfo((i) => i && { ...i, hasKey: true });
  };
  const connected = have.includes("mcp");
  const has = (d: "claude" | "codex") =>
    !!info?.clis.some((c) => c.driver === d);

  return (
    <div className="max-w-2xl space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        {has("claude") && (
          <Button size="sm" disabled={busy} onClick={() => void act(true)}>
            {added ? <Check /> : null} Add to Claude Code
          </Button>
        )}
        {has("codex") && (
          <Button size="sm" variant="outline" disabled>
            Add to Codex (coming soon)
          </Button>
        )}
        {info && !info.clis.length && (
          <p className="text-muted-foreground">
            No Claude Code or Codex found on this Mac. Paste the command below
            once you have one.
          </p>
        )}
      </div>
      {error && <p className="text-xs text-rose-500">{error}</p>}

      {/* one Full key per account: a second way to make one would cut off the first, so the command is only for a Mac with no button */}
      {info && !has("claude") && (
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
