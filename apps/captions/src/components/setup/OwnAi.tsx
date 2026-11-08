import { useEffect, useState } from "react";
import { AppWindow, Check, Layers, Loader2, SquareTerminal, type LucideIcon } from "lucide-react";
import type { Have } from "@contracts/tools";
import type { WorkPrefs } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/workshop/CopyButton";
import { Choice } from "./Choice";

type Talk = WorkPrefs["talk"];

const WAYS: Array<{ talk: Talk; name: string; what: string; icon: LucideIcon }> = [
  { talk: "app", name: "In the app", what: "Plan, edit and review here, with the assistant beside you.", icon: AppWindow },
  { talk: "chat", name: "In my own AI", what: "Keep working in Claude Code or Codex. Creator Toolset works in the background.", icon: SquareTerminal },
  { talk: "both", name: "Both", what: "Ask from your own AI, and open the app to see and touch the work.", icon: Layers },
];

/** Setup's first question: where they talk to the AI (work-prefs `talk`), three cards side by side. */
export function HowPicker({ value, onPick }: { value: Talk; onPick: (t: Talk) => void }) {
  return (
    <div role="radiogroup" aria-label="How do you want to work?" className="grid gap-3 sm:grid-cols-3">
      {WAYS.map((w) => (
        <Choice key={w.talk} big on={w.talk === value} onClick={() => onPick(w.talk)} icon={w.icon} name={w.name} line={w.what} />
      ))}
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
