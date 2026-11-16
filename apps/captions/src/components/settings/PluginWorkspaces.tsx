import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, EmptyRow, ErrorRow, LoadingRow, Notice, Row, saveFailed, Section } from "@/components/settings/ui";
import { pluginOffHere, useMe } from "@/lib/auth";
import { getEditSteps } from "@/lib/editor";
import { scopeRequests } from "@/lib/current-workspace";
import { useWorkspace } from "@/lib/workspace";
import { webPlugins } from "@/plugins.gen";
import { HOME_TILE_NAMES } from "@contracts/tools";

/**
 * Which workspaces an installed plug-in works in (api/lib/plugin-workspaces.ts): every workspace, or only the ones
 * switched on. At the top of each plug-in's settings. A plug-in that changes the whole server says it is on everywhere.
 */
export interface PluginWorkspacesView {
  id: string;
  name: string;
  fixed?: string;
  all: boolean;
  workspaces: { id: string; name: string; on: boolean }[];
}

async function send(id: string, body?: unknown): Promise<PluginWorkspacesView> {
  const r = await fetch(`/api/plugins/${encodeURIComponent(id)}/workspaces`, body === undefined ? undefined : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as (PluginWorkspacesView & { error?: string }) | null;
  if (!r.ok || !j) throw new Error(j?.error ?? "That did not save. Try again.");
  return j;
}

export function PluginWorkspaces({ id, onView }: { id: string; onView?: (v: PluginWorkspacesView) => void }) {
  const [view, setView] = useState<PluginWorkspacesView | null>(null);
  const [failed, setFailed] = useState(false);
  const show = useCallback((v: PluginWorkspacesView) => (setView(v), onView?.(v)), [onView]);
  const load = useCallback(() => send(id).then(show, () => setFailed(true)), [id, show]);
  useEffect(() => void load(), [load]);
  const save = (body: { all: true } | { only: string[] }) =>
    send(id, body).then(
      (v) => {
        show(v);
        // the switcher's copy says what is off where: the page hides it there at once
        void useWorkspace.getState().load();
      },
      (e: Error) => saveFailed(e.message),
    );

  let rows: ReactNode;
  if (failed && !view) rows = <ErrorRow title="The workspaces could not be read" retry={() => { setFailed(false); void load(); }} />;
  else if (!view) rows = <LoadingRow />;
  // no switch: the row says why, in words
  else if (view.fixed) rows = <Row title="All workspaces" description={view.fixed} />;
  else if (!view.workspaces.length) rows = <EmptyRow title="All workspaces" description="You have no workspaces yet." />;
  else {
    const on = (w: { on: boolean }) => view.all || w.on;
    rows = (
      <>
        <Row
          title="All workspaces"
          description="Also the ones you add later"
          control={
            <Switch
              checked={view.all}
              aria-label={`${view.name} in all workspaces`}
              // off keeps every workspace on, so nothing disappears until one is switched off
              onCheckedChange={(all) => void save(all ? { all: true } : { only: view.workspaces.map((w) => w.id) })}
            />
          }
        />
        {view.workspaces.map((w) => (
          <Row
            key={w.id}
            title={w.name}
            control={
              <Switch
                checked={on(w)}
                aria-label={`${view.name} in ${w.name}`}
                onCheckedChange={(v) => void save({ only: view.workspaces.filter((x) => (x.id === w.id ? v : on(x))).map((x) => x.id) })}
              />
            }
          />
        ))}
      </>
    );
  }
  return (
    <Section title="Workspaces">
      <Card>{rows}</Card>
    </Section>
  );
}

/** The plug-in a Settings section belongs to (its own section, not a server-wide one), or undefined. */
export const pluginOfSection = (sectionId: string) => webPlugins.find((p) => p.settings?.some((s) => s.id === sectionId && !s.adminTab))?.id;

/**
 * A plug-in's own settings under its workspaces. They are a workspace's own: the window's when the plug-in is on there,
 * else one where it is on (its requests, /api/x/<id>/, say that workspace), and a choice when it is on in several.
 */
export function WithPluginWorkspaces({ id, children }: { id: string; children: ReactNode }) {
  useMe(); // drawn again when the workspace changes what is off here
  const current = useWorkspace((s) => s.currentProjectId);
  const [view, setView] = useState<PluginWorkspacesView | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const places = view && !view.fixed ? view.workspaces.filter((w) => view.all || w.on) : [];
  const here = !pluginOffHere(id) && (!view || !!view.fixed || !view.workspaces.length || places.some((w) => w.id === current));
  const target = places.find((w) => w.id === picked) ?? (here ? places.find((w) => w.id === current) : places[0]);
  const prefix = `/api/x/${id}/`;
  // set while drawing, before the settings below fetch in their effects
  scopeRequests(prefix, target && target.id !== current ? target.id : null);
  useEffect(() => () => scopeRequests(prefix, null), [prefix]);

  let body: ReactNode = children;
  if (!here && !target) body = view ? <Notice>It is off in every workspace. Switch it on for one above to change its settings.</Notice> : null;
  else if (places.length > 1 && target)
    body = (
      <>
        <Section title="Settings for">
          <Card>
            {places.map((w) => (
              <Row
                key={w.id}
                title={w.name}
                description={w.id === current ? "This workspace" : undefined}
                control={
                  w.id === target.id ? (
                    <span className="text-xs text-muted-foreground">Shown below</span>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setPicked(w.id)}>Show</Button>
                  )
                }
              />
            ))}
          </Card>
        </Section>
        <div key={target.id}>{children}</div>
      </>
    );
  else if (target && target.id !== current)
    body = (
      <>
        <Notice>These are its settings for {target.name}.</Notice>
        <div key={target.id}>{children}</div>
      </>
    );
  return (
    <>
      <PluginWorkspaces id={id} onView={setView} />
      {body}
    </>
  );
}

/**
 * Settings → a plug-in (`/settings/plugin/<id>`), the page Community's Settings button opens for every installed plug-in:
 * its workspaces, then its own settings (a section of its own, or a link to the tool page that holds them).
 */
export function PluginSettingsPage({ sub }: { sub?: string }) {
  const id = sub ?? "";
  const own = webPlugins.find((p) => p.id === id)?.settings?.filter((s) => !s.adminTab) ?? [];
  const [step, setStep] = useState(false);
  useEffect(() => void getEditSteps().then((v) => setStep(v.steps.some((r) => r.pluginId === id && r.state === "on")), () => {}), [id]);
  // the tool pages that hold its settings (a section that names a tool, an AI Editor step's options), one link each
  const tools = [...new Set([...own.flatMap((s) => (s.tool ? [s.tool] : [])), ...(step ? (["editor"] as const) : [])])];
  return (
    <WithPluginWorkspaces id={id}>
      {own.filter((s) => !s.tool).map((s) => <div key={s.id}>{s.body}</div>)}
      {tools.length > 0 && (
        <Section title="Settings">
          <Card>
            {tools.map((t) => (
              <Row key={t} title={<Link to={`/settings/tools/${t}`} className="underline-offset-4 hover:underline">{HOME_TILE_NAMES[t]}</Link>} />
            ))}
          </Card>
        </Section>
      )}
    </WithPluginWorkspaces>
  );
}
