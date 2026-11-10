import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { LocalAiView } from "@contracts/local-ai";
import { APPS, LocalAppRow, REMOTE_APPS, RemoteAppRow, connectableRows, useOwnAi, type AiKeyInfo } from "@/components/settings/OwnAiSection";
import { Card, ErrorRow, LoadingRow } from "@/components/settings/ui";
import { useMe } from "@/lib/auth";
import { putCached, readCached } from "@/lib/local-cache";

/** This screen's saved copy (lib/local-cache.ts): the AI apps found on this computer and which of them have Creator Toolset (names and dates, nothing of a key). */
const SAVED = "setup/own-ai";
type Saved = { keys: AiKeyInfo[]; local: LocalAiView };

/**
 * What the screen shows: the read Settings → Headless access makes (useOwnAi), and until it answers, what it answered
 * last time. Looking at this computer's AI apps takes a second or more, and the rows are there meanwhile. Only an
 * answer from this computer is saved, never the stand-in a failed read leaves.
 */
function useOwnAiSaved() {
  const fresh = useOwnAi();
  const user = useMe()?.username;
  const saved = readCached<Saved>(user, SAVED);
  useEffect(() => {
    if (fresh.keys && fresh.local?.local) putCached(user, SAVED, { keys: fresh.keys.map((k) => ({ ...k, last4: "" })), local: fresh.local });
  }, [user, fresh.keys, fresh.local]);
  return { ...fresh, keys: fresh.keys ?? saved?.keys ?? null, local: fresh.local ?? saved?.local ?? null };
}

/**
 * Setup's last screen after "In my own AI" or "Both": the AI apps, one row each with the button that installs Creator
 * Toolset in it. The rows are the ones on Settings → Headless access, so what is installed here shows as installed
 * there. On this computer's own server they are the apps it found (Sign in or Update first when that is what one
 * needs); on any other server they are Claude Code and Codex, installed by the Mac app. Install does the work itself:
 * setup never shows a line to run.
 *
 * `into`: setup mounts this one screen early, while the question before it is still up, and gives it the place to show
 * its rows once its own screen opens (null until then: it reads and shows nothing). So the wait for this computer's AI
 * apps is over, or mostly over, by the time the screen is looked at. Without `into` it shows where it is mounted.
 */
export function OwnAiStep({ into }: { into?: HTMLElement | null }) {
  const rows = <OwnAiRows {...useOwnAiSaved()} />;
  return into === undefined ? rows : into && createPortal(rows, into);
}

function OwnAiRows({ keys, local, error, load, disconnect }: ReturnType<typeof useOwnAiSaved>) {
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
