import { LocalAppRow, connectableRows, useOwnAi } from "@/components/settings/OwnAiSection";
import { Card, ErrorRow, LoadingRow } from "@/components/settings/ui";

/**
 * Setup's last screen after "In my own AI" or "Both": the AI apps on this computer, one row each with the button that
 * installs Creator Toolset in it (Sign in or Update first when that is what it needs). The rows are the ones on
 * Settings → Headless access, so what is installed here shows as installed there.
 */
export function OwnAiStep() {
  const { keys, local, error, load, disconnect } = useOwnAi();
  if (!local || !keys)
    return <Card>{error ? <ErrorRow title="Couldn't load your AI apps" detail={error} retry={load} /> : <LoadingRow />}</Card>;
  const rows = local.local ? connectableRows(local) : [];
  if (!rows.length)
    return <p className="text-sm text-muted-foreground">No Claude Code or Codex was found on this computer. You can install Creator Toolset in one later, in Settings → Headless access.</p>;
  return (
    <Card>
      {rows.map((r) => (
        <LocalAppRow key={r.id} row={r} aiKey={keys.find((k) => k.name === r.name)} onDone={load} onDisconnect={disconnect} />
      ))}
    </Card>
  );
}
