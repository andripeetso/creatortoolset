import { useCallback, useEffect, useState } from "react";
import type { ServerWorkView } from "@contracts/work";
import { Switch } from "@/components/ui/switch";
import { call, msg } from "./ServerWorkSection";
import { Card, ErrorRow, LoadingRow, Row, saveFailed, Section } from "./ui";

/** The admin's view of the server (GET /api/work/server-work): the switch and its workspaces; set only on a server by address. */
type Admin = NonNullable<ServerWorkView["admin"]>;

const RENDERING_TIP = "On: this server does the video work (renders, proxies, transcripts, analysis). Off: everyone uses their own computer.";

/**
 * Settings → Workspace policies (the Server group, admin): where each workspace's video work runs. On a server by
 * address the switch saves here; on This Mac and on Creator Toolset Cloud the master is shown read-only, and Cloud has no
 * per-workspace rows (they would list every customer's workspaces).
 */
export function WorkspacePoliciesSection() {
  const [view, setView] = useState<ServerWorkView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => call<ServerWorkView>("/api/work/server-work").then(setView, () => setFailed(true)), []);
  useEffect(() => void load(), [load]);
  if (failed && !view)
    return (
      <Section title="Workspace policies">
        <Card>
          <ErrorRow title="Could not load workspace policies" retry={() => (setFailed(false), void load())} />
        </Card>
      </Section>
    );
  if (!view)
    return (
      <Section title="Workspace policies">
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );
  const a = view.admin;
  const save = (body: { on: boolean } | { all: true } | { only: string[] }) =>
    call<Admin>("/api/work/server-work", body).then((next) => setView((v) => (v ? { ...v, admin: next } : v)), (e) => saveFailed(msg(e)));
  return (
    <Section title="Workspace policies">
      <Card>
        {a ? (
          <Row
            title="Server rendering"
            tip={RENDERING_TIP}
            status={a.offByUpdate ? "Turned off by an update: video work now runs on each person's own computers unless this is on." : undefined}
            control={<Switch checked={a.on} aria-label="Server rendering" onCheckedChange={(v) => void save({ on: v })} />}
          />
        ) : (
          <Row
            title="Server rendering"
            tip={RENDERING_TIP}
            status={view.kind === "mac" ? "This Mac does all video work" : undefined}
            control={<Switch checked={view.kind === "mac" || !!view.place?.allowed} disabled aria-label="Server rendering" />}
          />
        )}
        {a?.on && a.workspaces.length > 0 && (
          <>
            <Row
              title="All workspaces"
              control={
                <Switch
                  checked={a.all}
                  aria-label="All workspaces"
                  // off keeps every workspace on, so nothing stops until one is switched off
                  onCheckedChange={(all) => void save(all ? { all: true } : { only: a.workspaces.map((w) => w.id) })}
                />
              }
            />
            {!a.all &&
              a.workspaces.map((w) => (
                <Row
                  key={w.id}
                  title={w.name}
                  control={
                    <Switch
                      checked={w.on}
                      aria-label={`Server rendering for ${w.name}`}
                      onCheckedChange={(v) => void save({ only: a.workspaces.filter((x) => (x.id === w.id ? v : x.on)).map((x) => x.id) })}
                    />
                  }
                />
              ))}
          </>
        )}
      </Card>
    </Section>
  );
}
