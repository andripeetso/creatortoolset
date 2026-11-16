import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card, EmptyRow, ErrorRow, LoadingRow, Notice, Row, saveFailed, Section } from "@/components/settings/ui";
import { pluginOffHere, useMe } from "@/lib/auth";
import { getEditSteps } from "@/lib/editor";
import { useWorkspace } from "@/lib/workspace";
import { webPlugins } from "@/plugins.gen";

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

export function PluginWorkspaces({ id }: { id: string }) {
  const [view, setView] = useState<PluginWorkspacesView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => send(id).then(setView, () => setFailed(true)), [id]);
  useEffect(() => void load(), [load]);
  const save = (body: { all: true } | { only: string[] }) =>
    send(id, body).then(
      (v) => {
        setView(v);
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
  else
    rows = (
      <>
        <Row
          title="Works in"
          control={
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={view.all ? "all" : "some"}
              // Only these starts with every workspace on, so nothing disappears until a switch is turned off
              onValueChange={(v) => v && v !== (view.all ? "all" : "some") && void save(v === "all" ? { all: true } : { only: view.workspaces.map((w) => w.id) })}
              aria-label="Which workspaces"
            >
              <ToggleGroupItem value="all" className="px-2.5 text-xs">All workspaces</ToggleGroupItem>
              <ToggleGroupItem value="some" className="px-2.5 text-xs">Only these</ToggleGroupItem>
            </ToggleGroup>
          }
        />
        {!view.all &&
          view.workspaces.map((w) => (
            <Row
              key={w.id}
              title={w.name}
              control={
                <Switch
                  checked={w.on}
                  aria-label={`${view.name} in ${w.name}`}
                  onCheckedChange={(on) => void save({ only: view.workspaces.filter((x) => (x.id === w.id ? on : x.on)).map((x) => x.id) })}
                />
              }
            />
          ))}
      </>
    );
  return (
    <Section title="Workspaces">
      <Card>{rows}</Card>
    </Section>
  );
}

/** The plug-in a Settings section belongs to (its own section, not a server-wide one), or undefined. */
export const pluginOfSection = (sectionId: string) => webPlugins.find((p) => p.settings?.some((s) => s.id === sectionId && !s.adminTab))?.id;

/** A plug-in's own settings under its workspaces; in a workspace where it is off, only a line on how to turn it on. */
export function WithPluginWorkspaces({ id, children }: { id: string; children: ReactNode }) {
  useMe(); // drawn again when the workspace changes what is off here
  return (
    <>
      <PluginWorkspaces id={id} />
      {pluginOffHere(id) ? <Notice>It is off in this workspace. Switch it on for this workspace above to use it and change its settings here.</Notice> : children}
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
  const links = [
    ...own.filter((s) => s.tool).map((s) => ({ to: `/settings/tools/${s.tool}`, text: s.title })),
    ...(step ? [{ to: "/settings/tools/editor", text: "Its options for new AI Editor edits" }] : []),
  ];
  return (
    <WithPluginWorkspaces id={id}>
      {own.filter((s) => !s.tool).map((s) => <div key={s.id}>{s.body}</div>)}
      {links.length > 0 && (
        <Section title="Settings">
          <Card>
            {links.map((l) => (
              <Row key={l.to} title={<Link to={l.to} className="underline-offset-4 hover:underline">{l.text}</Link>} />
            ))}
          </Card>
        </Section>
      )}
    </WithPluginWorkspaces>
  );
}
