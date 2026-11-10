import { APPS, LocalAppRow, REMOTE_APPS, RemoteAppRow, connectableRows, useOwnAi } from "@/components/settings/OwnAiSection";
import { Card, ErrorRow, LoadingRow } from "@/components/settings/ui";

/**
 * Setup's last screen after "In my own AI" or "Both": the AI apps, one row each with the button that installs Creator
 * Toolset in it. The rows are the ones on Settings → Headless access, so what is installed here shows as installed
 * there. On this computer's own server they are the apps it found (Sign in or Update first when that is what one
 * needs); on any other server they are Claude Code and Codex, installed by the Mac app. Install does the work itself:
 * setup never shows a line to run.
 */
export function OwnAiStep() {
  const { keys, local, error, load, disconnect } = useOwnAi();
  if (!local || !keys)
    return <Card>{error ? <ErrorRow title="Couldn't load your AI apps" detail={error} retry={load} /> : <LoadingRow />}</Card>;
  if (!local.local)
    return (
      <Card>
        {REMOTE_APPS.map((a) => (
          <RemoteAppRow key={a} app={a} aiKey={keys.find((k) => k.name === APPS[a].name)} onDone={load} onDisconnect={disconnect} commands={false} />
        ))}
      </Card>
    );
  const rows = connectableRows(local);
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
