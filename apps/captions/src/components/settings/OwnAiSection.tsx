import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { CliId, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { AccessKeysSection } from "./AccessKeys";
import { ProviderLogo } from "./ProviderLogos";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section, Status, saveFailed } from "./ui";
import { msg } from "./helpers";

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/** The AI apps on this Mac that can use Creator Toolset (Claude Code, Codex; Gemini has no key path). */
export const connectableRows = (view: LocalAiView) =>
  view.rows.filter((r): r is LocalAiRow & { id: CliId } => r.kind === "cli" && r.found && r.mcp !== "n/a" && r.id !== "gemini");

/**
 * Settings → Your own AI: the app gives your own AI (Claude Code, Codex) a key, so it can work here as you. Each AI app
 * found on this Mac is one row with [Connect]. Access keys (for AIs and scripts) sit below, with sign-in.
 */
export function OwnAiSection() {
  const required = useAuth((s) => s.required);
  return (
    <>
      <ConnectAiSection />
      {required && <AccessKeysSection />}
    </>
  );
}

/** "Connect your AI": the Mac's AI apps, one row each. Also what Settings → Providers used to hold; now its own section. */
export function ConnectAiSection() {
  const [view, setView] = useState<LocalAiView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CliId | null>(null);
  const [failed, setFailed] = useState<Partial<Record<CliId, string>>>({});

  const load = () =>
    fetch("/api/setup/ai")
      .then((r) => json<LocalAiView>(r))
      .then((v) => (setView(v), setError(null)))
      .catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, []);

  const add = async (id: CliId) => {
    setBusy(id);
    setFailed((f) => ({ ...f, [id]: undefined }));
    try {
      const res = await fetch("/api/setup/ai/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => json<{ ok: boolean; failed: Array<{ id: CliId; message: string }>; message?: string }>(r));
      const mine = res.failed.find((x) => x.id === id);
      if (mine || !res.ok) setFailed((f) => ({ ...f, [id]: mine?.message ?? res.message ?? "it could not be added" }));
    } catch (e) {
      setFailed((f) => ({ ...f, [id]: msg(e) }));
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <Section id="connect-ai" title="Connect your AI">
      <Card>
        {!view ? (
          error ? <ErrorRow title="Couldn't load your AI apps" detail={error} retry={() => void load()} /> : <LoadingRow />
        ) : (
          <ConnectAiRows view={view} busy={busy} failed={failed} onAdd={(id) => void add(id)} />
        )}
      </Card>
    </Section>
  );
}

/** The rows for a loaded view: pure, so each state can be checked without a server. */
export function ConnectAiRows({ view, busy, failed, onAdd }: { view: LocalAiView; busy: CliId | null; failed: Partial<Record<CliId, string>>; onAdd: (id: CliId) => void }) {
  if (!view.local)
    return <EmptyRow title="Connect your AI from the Mac app" description="Claude Code and Codex run on a Mac. Open Creator Toolset on that Mac to connect them." />;
  const rows = connectableRows(view);
  if (rows.length === 0)
    return <EmptyRow title="Use the app from Claude, ChatGPT or a script" description="Your own AI can read and work in your projects here." />;
  return (
    <>
      {rows.map((r) => (
        <AiRow key={r.id} row={r} busy={busy === r.id} failed={failed[r.id]} onAdd={() => onAdd(r.id)} />
      ))}
    </>
  );
}

function AiRow({ row, busy, failed, onAdd }: { row: LocalAiRow; busy: boolean; failed?: string; onAdd: () => void }) {
  let status: ReactNode = undefined;
  let action: ReactNode = null;
  let subtitle: string | undefined = row.version ? `Version ${row.version}` : undefined;
  if (!row.connected) {
    status = <Status tone="attention">Sign in to {row.name} on this Mac first</Status>;
  } else if (row.mcp === "added") {
    action = <Status>Connected</Status>;
  } else if (row.mcp === "update") {
    status = <Status tone="attention">Needs an update first</Status>;
    action = row.updateCommand ? <CopyCommand text={row.updateCommand} /> : null;
    subtitle = row.updateCommand;
  } else if (failed) {
    status = <Status tone="broken">Couldn't add it: {failed}</Status>;
    action = (
      <Button size="xs" variant="outline" disabled={busy} onClick={onAdd}>
        Try again
      </Button>
    );
  } else {
    action = (
      <Button size="xs" variant="outline" disabled={busy} onClick={onAdd}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
    );
  }
  return (
    <ListRow
      icon={<ProviderLogo driver={row.id} className="size-4" />}
      title={row.name}
      subtitle={subtitle}
      status={status}
      actions={action}
    />
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Copy the update command"
      title={text}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => saveFailed("Couldn't copy it. Select the command and copy it."),
        )
      }
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
