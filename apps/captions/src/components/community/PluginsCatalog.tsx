import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { StepRow, StepsView } from "@contracts/editor-steps";
import { isHomeTile, type HomeTile } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { Card, ErrorRow, InUse, ListRow, LoadingRow, saveFailed, Section } from "@/components/settings/ui";
import { StepRowView } from "@/components/settings/EditorStepsSection";
import { addEditStep, getEditSteps, setEditStep } from "@/lib/editor";
import { switchPluginOn } from "@/lib/thisMac";
import { webPlugins } from "@/plugins.gen";

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

/** The rows that add to one tool (null = the ones that name no Home tool), matching the search. */
export function stepsFor(view: StepsView | null, tool: HomeTile | null, q = ""): StepRow[] {
  const s = q.trim().toLowerCase();
  return (view?.steps ?? []).filter((r) => toolOf(r) === tool && (!s || [r.title, r.about].some((v) => v.toLowerCase().includes(s))));
}

/**
 * A tool's "Plug-ins" section; nothing when it has none. `inSettings`: on the tool's own page, where a loaded AI Editor
 * step needs no Settings link, and, with `switches` (the Mac app's own server, where that Mac app runs the steps), shows
 * its switch for new edits and its options instead of Installed.
 */
export function ToolPlugins({ steps, tool, q, inSettings = false, switches = false }: { steps: Steps; tool: HomeTile | null; q?: string; inSettings?: boolean; switches?: boolean }) {
  if (steps.error) return <Section title="Plug-ins"><Card><ErrorRow title="The plug-ins could not be read" retry={steps.retry} /></Card></Section>;
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
            <PluginRow key={r.folder ?? r.id} row={r} canAdd={steps.view!.canAdd} inSettings={inSettings} />
          ),
        )}
      </Card>
    </Section>
  );
}

function PluginRow({ row, canAdd, inSettings }: { row: StepRow; canAdd: boolean; inSettings: boolean }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      if (row.state === "add") await addEditStep(row.folder!);
      const r = await switchPluginOn(row.folder!);
      if (r && !r.ok && r.problem) saveFailed(r.problem);
    } catch {
      saveFailed(`${row.title} could not be downloaded. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  // a step's settings are on the AI Editor's page; another plug-in's, its own section (from its page half, read now)
  const own = webPlugins.find((p) => p.id === row.id)?.settings?.find((x) => !x.adminTab)?.id;
  const to = row.state === "on" ? (inSettings ? null : "/settings/tools/editor") : own ? `/settings/${own}` : null;
  const actions =
    row.state === "on" || row.state === "loaded" ? (
      <>
        <InUse>Installed</InUse>
        {to && (
          <Button asChild size="sm" variant="outline">
            <Link to={to}>Settings</Link>
          </Button>
        )}
      </>
    ) : canAdd ? (
      <Button size="sm" disabled={busy} onClick={() => void download()}>
        {row.state === "add" ? "Download" : "Switch on"}
      </Button>
    ) : undefined;
  return <ListRow title={row.title} subtitle={row.about} actions={actions} />;
}
