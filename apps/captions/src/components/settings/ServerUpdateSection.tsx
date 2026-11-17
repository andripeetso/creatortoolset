import { useCallback, useEffect, useState } from "react";
import type { ServerUpdateView } from "@contracts/server-update";
import { Button } from "@/components/ui/button";
import { Card, Row, saveFailed, Section, Status } from "./ui";

/** What the row says under "This server": the state, never a sentence. */
export function updateLine(v: { behind: number; failed: boolean }): string {
  if (v.failed) return "Update failed";
  if (v.behind === 0) return "Up to date";
  return `${v.behind} ${v.behind === 1 ? "change" : "changes"} waiting`;
}

/**
 * Settings → Storage, an admin of a server whose machine runs the updater (api/server-update.ts): what is waiting,
 * Update now, and the hour it updates each night (in this person's own time zone, whatever the server's clock is). A server with no updater (This Mac, Creator Toolset Cloud) shows
 * nothing: the Mac app's own update brings its server, and the cloud is updated for everyone.
 */
/**
 * This server's update, for an admin (`enabled`): null while loading, for a member, or with no updater on its machine.
 * `ask` starts it; `busy` holds while it runs (its end comes from the machine, so the view looks again every 15 s).
 */
export function useServerUpdate(enabled = true) {
  const [view, setView] = useState<ServerUpdateView | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(
    () =>
      fetch("/api/server-update")
        .then((r) => (r.ok ? (r.json() as Promise<ServerUpdateView>) : null))
        .then((v) => v && setView(v), () => {}),
    [],
  );
  useEffect(() => void (enabled && load()), [enabled, load]);
  // Only while an update is running: its end comes from the machine, not from this page, so the row looks again.
  const running = !!view?.available && view.requested;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [running, load]);
  const ask = () => {
    setAsking(true);
    fetch("/api/server-update/request", { method: "POST" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as (ServerUpdateView & { error?: string }) | null;
        if (!r.ok || !j) throw new Error(j?.error ?? "Could not start the update");
        setView(j);
      })
      .catch((e) => saveFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setAsking(false));
  };
  const on = enabled && view?.available ? view : null;
  return { view: on, ask, busy: asking || !!on?.requested };
}

/** Under a server's name (Settings → Servers) and in its Update row: the update's state, or nothing when it is up to date. */
export function UpdateStatus({ view, busy }: { view: Extract<ServerUpdateView, { available: true }>; busy: boolean }) {
  if (busy) return <Status>{view.waiting ? "Waiting for running work" : "Updating"}</Status>;
  if (view.behind === 0 && !view.failed) return null;
  return <Status tone={view.failed ? "broken" : undefined}>{updateLine(view)}</Status>;
}

export function ServerUpdateSection() {
  const { view, ask, busy } = useServerUpdate();
  if (!view) return null;
  return (
    <Section title="Update">
      <Card>
        <Row
          title="This server"
          status={busy ? <UpdateStatus view={view} busy /> : <Status tone={view.failed ? "broken" : undefined}>{updateLine(view)}</Status>}
          control={
            view.behind > 0 && (
              // the same button in the same place while it runs: it only goes once the server is up to date
              <Button size="sm" variant="outline" disabled={busy} onClick={ask}>
                {view.failed && !busy ? "Retry" : "Update now"}
              </Button>
            )
          }
        />
        {view.nightly !== null && <Row title="Automatic update" control={<Status>Every night at {new Date(view.nightly * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Status>} />}
      </Card>
    </Section>
  );
}
