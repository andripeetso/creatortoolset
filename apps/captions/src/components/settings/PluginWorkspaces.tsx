import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Switch } from "@/components/ui/switch";
import { Card, EmptyRow, ErrorRow, LoadingRow, Notice, Row, saveFailed, Section, useSettingsWorkspace, WorkspacePick } from "@/components/settings/ui";
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
  if (!r.ok || !j) throw new Error(j?.error ?? "Could not save");
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
  if (failed && !view) rows = <ErrorRow title="Could not load workspaces" retry={() => { setFailed(false); void load(); }} />;
  else if (!view) rows = <LoadingRow />;
  // no switch: the row says why, in words
  else if (view.fixed) rows = <Row title="All workspaces" description={view.fixed} />;
  else if (!view.workspaces.length) rows = <EmptyRow title="No workspaces" />;
  else {
    const on = (w: { on: boolean }) => view.all || w.on;
    rows = (
      <>
        <Row
          title="All workspaces"
          description="Includes workspaces added later."
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
 * A plug-in's own settings under its workspaces. They are a workspace's own, so the page's header has the workspace
 * selector over the workspaces the plug-in is on in, and the settings below are the chosen one's (their requests,
 * /api/x/<id>/, say that workspace). They are never locked because the window is in a workspace where it is off: the
 * selector then starts on one where it is on. On in one workspace only, there is nothing to choose. Fixed on for the
 * whole server, it has one set of settings and no selector.
 */
export function WithPluginWorkspaces({ id, children }: { id: string; children: ReactNode }) {
  useMe(); // drawn again when the workspace changes what is off here
  const current = useWorkspace((s) => s.currentProjectId);
  const [view, setView] = useState<PluginWorkspacesView | null>(null);
  const places = view && !view.fixed ? view.workspaces.filter((w) => view.all || w.on) : [];
  // until the server says where it is on, every workspace: the choice made on another Settings page is not lost
  const w = useSettingsWorkspace("one", view ? places.map((p) => p.id) : undefined);
  // the workspace whose settings are drawn: null = the window's own, undefined = none to draw
  let shown: string | null | undefined;
  if (!view) shown = !pluginOffHere(id) && (!w.id || w.id === current) ? null : undefined;
  else if (view.fixed || !view.workspaces.length) shown = null;
  else shown = (places.find((p) => p.id === w.id) ?? places.find((p) => p.id === current) ?? places[0])?.id;
  const prefix = `/api/x/${id}/`;
  // set while drawing, before the settings below fetch in their effects
  scopeRequests(prefix, shown && shown !== current ? shown : null);
  useEffect(() => () => scopeRequests(prefix, null), [prefix]);
  return (
    <>
      {view && <WorkspacePick mode="one" only={places.map((p) => p.id)} />}
      <PluginWorkspaces id={id} onView={setView} />
      {shown === undefined && view && <Notice>Off in every workspace.</Notice>}
      {/* no selector to say it (on in one workspace only, and the window is in another) */}
      {shown && shown !== current && !w.many && <Notice>These are its settings for {places.find((p) => p.id === shown)?.name}.</Notice>}
      {/* a keyed fragment: another workspace's settings are read anew, and the page's own spacing between sections stays */}
      {shown !== undefined && <Fragment key={shown ?? current ?? ""}>{children}</Fragment>}
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
