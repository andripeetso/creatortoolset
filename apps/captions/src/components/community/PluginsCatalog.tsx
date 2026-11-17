import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { StepRow, StepsView } from "@contracts/editor-steps";
import { isHomeTile, type HomeTile } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, ListRow, LoadingRow, RowMenu, saveFailed, Section } from "@/components/settings/ui";
import { PluginHereSwitch } from "@/components/settings/PluginWorkspaces";
import { StepRowView } from "@/components/settings/EditorStepsSection";
import { addEditStep, getEditSteps, setEditStep } from "@/lib/editor";
import { removePlugin, switchPluginOff, switchPluginOn, thisMacBridge, type PluginReply } from "@/lib/thisMac";

/**
 * The plug-ins the Creator Toolset team makes, each one a download, listed under the tool it adds to (its own plugin.ts
 * says which: `kind`, a Home tool id; contracts/editor-steps.ts): in Community's section for that tool and on the tool's
 * page in Settings → Tools. One that names no tool is in Community → Other. Download puts the plug-in's folder in the Mac
 * app's plug-ins folder and asks the Mac app to switch it on (its own alert; it then restarts its server and reloads this
 * window). Only the Mac app on its own server can take one in; elsewhere a tool lists only what is in.
 */

/** The Home tool a row adds to: a loaded step is the AI Editor's, a plug-in that comes with the app names its own (or none). */
export const toolOf = (r: StepRow): HomeTile | null => (r.state === "on" ? "editor" : isHomeTile(r.kind) ? r.kind : null);

/** The plug-ins list (GET /api/edit-steps), read once for whoever shows it. */
export function useSteps() {
  const [view, setView] = useState<StepsView | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => getEditSteps().then(setView, () => setError(true)), []);
  useEffect(() => void load(), [load]);
  const retry = () => {
    setError(false);
    void load();
  };
  return { view, error: error && !view, retry, setView };
}
export type Steps = ReturnType<typeof useSteps>;

/** The rows that add to one tool (null = the ones that name no Home tool, "all" = every row), matching the search. */
export function stepsFor(view: StepsView | null, tool: HomeTile | null | "all", q = ""): StepRow[] {
  const s = q.trim().toLowerCase();
  return (view?.steps ?? []).filter((r) => (tool === "all" || toolOf(r) === tool) && (!s || [r.title, r.about].some((v) => v.toLowerCase().includes(s))));
}

/**
 * A tool's "Plug-ins" section; nothing when it has none. With `switches` (on the tool's own page, on the Mac app's own
 * server, where that Mac app runs the steps) a loaded AI Editor step shows its switch for new edits and its options.
 * Elsewhere a plug-in from the person's own folder has an On switch (the Mac app's) and ⋯ → Remove, any other installed one
 * an On switch for the window's workspace (it can't be removed: the server is built with it), and each one Settings.
 */
export function ToolPlugins({ steps, tool, q, switches = false }: { steps: Steps; tool: HomeTile | null | "all"; q?: string; switches?: boolean }) {
  // best effort: a list that could not be read (a guest, the demo) leaves the section out, as for a tool with none
  if (steps.error) return null;
  if (!steps.view) return <Section title="Plug-ins"><Card><LoadingRow /></Card></Section>;
  const rows = stepsFor(steps.view, tool, q);
  if (!rows.length) return null;
  const change = (id: string, c: { use?: boolean; values?: Record<string, string> }) =>
    setEditStep(id, c).then(steps.setView, () => saveFailed("That did not save. Try again."));
  return (
    <Section title="Plug-ins">
      <Card>
        {rows.map((r) =>
          switches && r.state === "on" ? (
            <StepRowView key={r.id} step={r} onChange={(c) => change(r.id, c)} />
          ) : (
            <PluginRow key={r.folder ?? r.id} row={r} canAdd={steps.view!.canAdd} reload={steps.retry} />
          ),
        )}
      </Card>
    </Section>
  );
}

function PluginRow({ row, canAdd, reload }: { row: StepRow; canAdd: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  // the Mac app answers in its own dialog, then restarts its server and reloads this window; anything else gives the row back
  const run = async (ask: () => Promise<PluginReply | null>, failed: string) => {
    setBusy(true);
    try {
      const r = await ask();
      if (r && !r.ok && r.problem) saveFailed(r.problem);
      if (!r?.ok) setBusy(false);
    } catch {
      saveFailed(failed);
      setBusy(false);
    }
  };
  const download = () =>
    run(async () => {
      if (row.state === "add") await addEditStep(row.folder!);
      return switchPluginOn(row.folder!);
    }, `Could not download ${row.title}. Try again.`);
  const on = row.state === "on" || row.state === "loaded";
  // every installed plug-in has a page of its own: which workspaces it works in, then its settings (PluginWorkspaces.tsx)
  const to = `/settings/plugin/${encodeURIComponent(row.pluginId ?? row.id)}`;
  // one from the person's plug-ins folder, on the Mac app's own server, has the Mac app's switch; one the server is built with has none
  const toggle = canAdd && row.folder && row.state !== "add" && (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{on ? "On" : "Off"}</span>
      <Switch
        aria-label={`${row.title} on`}
        checked={on}
        disabled={busy}
        onCheckedChange={(v) => void run(() => (v ? switchPluginOn(row.folder!) : switchPluginOff(row.pluginId ?? row.id)), "That did not save. Try again.")}
      />
    </div>
  );
  // installed into the plug-ins folder (by Download, or the person's own): it can go. An on one needs the Mac app to stop it
  const removable = canAdd && row.folder && row.state !== "add" && (!on || !!thisMacBridge());
  const actions = (
    <>
      {toggle || (on && <PluginHereSwitch id={row.pluginId ?? row.id} name={row.title} />)}
      {on ? (
        <Button asChild size="sm" variant="outline">
          <Link to={to}>Settings</Link>
        </Button>
      ) : row.state === "add" && canAdd ? (
        <Button size="sm" disabled={busy} onClick={() => void download()}>
          Download
        </Button>
      ) : null}
      {removable && (
        <RowMenu
          label={`More for ${row.title}`}
          items={[
            {
              label: "Remove",
              destructive: true,
              confirm: { title: `Remove ${row.title}?`, body: "Its folder is deleted from the plug-ins folder. What it saved or made is kept.", ok: "Remove" },
              onSelect: () => run(async () => {
                const r = await removePlugin(row.folder!, on);
                // an on one: the Mac app restarts its server and reloads this window; an off one is read again here
                if (r.ok && !on) {
                  reload();
                  setBusy(false);
                }
                return r;
              }, `Could not remove ${row.title}. Try again.`),
            },
          ]}
        />
      )}
    </>
  );
  return <ListRow title={row.title} subtitle={row.about} actions={actions} />;
}
