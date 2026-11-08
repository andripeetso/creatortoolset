import { useEffect, useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";
import type { CliId, LocalAiRow, LocalAiView, McpResult } from "@contracts/local-ai";

import { Button } from "@/components/ui/button";
import { Card, Group, Row } from "./ui";

/** The Creator Toolset action for each CLI (6.5), shown only for Claude Code and Codex. */
const ACTION: Record<string, string> = {
  claude: "Let Claude Code use Creator Toolset",
  codex: "Let Codex use Creator Toolset",
};

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/**
 * Settings → Your AI → "Use Creator Toolset from your own AI" (chat and both paths only). One row per CLI found on
 * this Mac: added, not yet added (its button, off until clicked), too old, or not connected yet. Uses the same
 * endpoints as step 4 of the walk, so the two places always agree.
 */
export function OwnAiMcpSection() {
  const [view, setView] = useState<LocalAiView | null>(null);
  const [busy, setBusy] = useState<CliId | null>(null);
  const [failed, setFailed] = useState<Partial<Record<CliId, string>>>({});

  const load = () =>
    fetch("/api/setup/ai")
      .then((r) => json<LocalAiView>(r))
      .then(setView)
      .catch(() => setView({ local: false, rows: [] }));
  useEffect(() => {
    void load();
  }, []);

  const add = async (id: CliId) => {
    setBusy(id);
    setFailed((f) => ({ ...f, [id]: undefined }));
    try {
      const res = await fetch("/api/setup/ai/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => json<McpResult>(r));
      const mine = res.failed.find((x) => x.id === id);
      if (mine || !res.ok) setFailed((f) => ({ ...f, [id]: mine?.message ?? res.message ?? "it could not be added" }));
    } catch (e) {
      setFailed((f) => ({ ...f, [id]: e instanceof Error ? e.message : "it could not be added" }));
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (!view) return null;
  return <OwnAiMcpView view={view} busy={busy} failed={failed} onAdd={(id) => void add(id)} />;
}

/** The section's markup from the server's view: exported on its own so each state can be checked without a server. */
export function OwnAiMcpView({ view, busy, failed, onAdd }: { view: LocalAiView; busy: CliId | null; failed: Partial<Record<CliId, string>>; onAdd: (id: CliId) => void }) {
  const rows = view.rows.filter((r): r is LocalAiRow & { id: CliId } => r.kind === "cli" && r.found && r.mcp !== "n/a" && r.id !== "gemini");
  return (
    <Group title="Use Creator Toolset from your own AI" hint="Your own Claude Code or Codex can make captions, plan reels and check a cut here.">
      {!view.local ? (
        <p className="text-sm text-muted-foreground">Open the Creator Toolset Mac app to connect your AI. Browsers can't reach your Claude or Codex.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Claude Code or Codex found on this Mac yet.</p>
      ) : (
        <Card>
          {rows.map((r) => (
            <Row key={r.id} label={<span className="flex items-center gap-2">{r.name}{r.version && <span className="font-mono text-[11px] text-muted-foreground">v{r.version}</span>}</span>} hint={<CliLine row={r} failed={failed[r.id]} busy={busy === r.id} onAdd={() => onAdd(r.id)} />} />
          ))}
        </Card>
      )}
    </Group>
  );
}

function CliLine({ row, failed, busy, onAdd }: { row: LocalAiRow; failed?: string; busy: boolean; onAdd: () => void }) {
  if (!row.connected) return <span>Connect it in Settings → Your AI first.</span>;
  if (row.mcp === "added") {
    return (
      <span className="flex flex-col gap-0.5 text-emerald-600 dark:text-emerald-400">
        <span className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Added ✓</span>
        <span className="text-muted-foreground">You can see it in Settings → Your AI.</span>
      </span>
    );
  }
  if (row.mcp === "update") return <UpdateLine row={row} />;
  return (
    <span className="flex flex-col items-start gap-1">
      {failed ? (
        <span className="text-red-600 dark:text-red-400">Creator Toolset couldn't be added to {row.name}: {failed}. Your AI is still connected.</span>
      ) : (
        <span>So you can ask {row.name} to make captions, plan reels or check a cut here, from your own chat.</span>
      )}
      <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={onAdd}>
        {failed ? "Try again" : ACTION[row.id] ?? "Add Creator Toolset"}
      </Button>
    </span>
  );
}

/** Codex is too old for the setup it needs: the update command behind a disclosure, with a copy button. */
function UpdateLine({ row }: { row: LocalAiRow }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex flex-col items-start gap-1">
      <span>{row.name} needs an update before it can use Creator Toolset.</span>
      <details>
        <summary className="cursor-pointer underline underline-offset-2">How to update</summary>
        {row.updateCommand && (
          <span className="mt-1 flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-[11px] text-foreground">{row.updateCommand}</code>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              aria-label="Copy command"
              onClick={async () => {
                await navigator.clipboard?.writeText(row.updateCommand!);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <CheckCircle2 /> : <Copy />}
            </Button>
          </span>
        )}
      </details>
    </span>
  );
}
