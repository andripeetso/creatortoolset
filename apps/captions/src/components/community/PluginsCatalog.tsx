import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { StepRow, StepsView } from "@contracts/editor-steps";
import { HOME_TILES, HOME_TILE_NAMES, isHomeTile, type HomeTile } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { Card, EmptyRow, ErrorRow, InUse, ListRow, LoadingRow, saveFailed, Section } from "@/components/settings/ui";
import { addEditStep, getEditSteps } from "@/lib/editor";
import { switchPluginOn } from "@/lib/thisMac";
import { webPlugins } from "@/plugins.gen";

/**
 * Community → Plug-ins: the plug-ins the Creator Toolset team makes, each one a download, under the name of the tool it
 * adds to, in Home's order (its own plugin.ts says which: `kind`, a Home tool id; contracts/editor-steps.ts). One that
 * names no tool is under Other, last. Download puts the plug-in's folder in the Mac app's plug-ins folder and asks the Mac
 * app to switch it on (its own alert; it then restarts its server and reloads this window). A plug-in that is in has its
 * own settings: a step's are in Settings → AI Editor, another's in its own Settings section. Only the Mac app on its own
 * server can take one in; elsewhere the list says where to get them.
 */
const OTHER = "Other";
/** The Home tool a row adds to: a loaded step is the AI Editor's, a plug-in that comes with the app names its own (or none). */
const toolOf = (r: StepRow): HomeTile | null => (r.state === "on" ? "editor" : isHomeTile(r.kind) ? r.kind : null);
const headingOf = (r: StepRow) => {
  const t = toolOf(r);
  return t ? HOME_TILE_NAMES[t] : OTHER;
};

export function PluginsView({ q }: { q: string }) {
  const [view, setView] = useState<StepsView | null>(null);
  const [error, setError] = useState(false);
  const load = () => getEditSteps().then(setView, () => setError(true));
  useEffect(() => void load(), []);
  if (error && !view) return <Card><ErrorRow title="The plug-ins could not be read" retry={() => { setError(false); void load(); }} /></Card>;
  if (!view) return <Card><LoadingRow /></Card>;
  const s = q.trim().toLowerCase();
  const rows = view.steps.filter((r) => !s || [r.title, r.about, headingOf(r)].some((v) => v.toLowerCase().includes(s)));
  if (!rows.length)
    return <Card><EmptyRow title={!view.canAdd && !view.steps.length ? "Plug-ins download into the Creator Toolset Mac app" : "Nothing matches your search."} /></Card>;
  const groups = [...HOME_TILES.map((t) => HOME_TILE_NAMES[t]), OTHER].map((title) => ({ title, rows: rows.filter((r) => headingOf(r) === title) }));
  return (
    <>
      {groups.filter((g) => g.rows.length).map((g) => (
        <Section key={g.title} title={g.title}>
          <Card>
            {g.rows.map((r) => <PluginRow key={r.folder ?? r.id} row={r} canAdd={view.canAdd} />)}
          </Card>
        </Section>
      ))}
    </>
  );
}

function PluginRow({ row, canAdd }: { row: StepRow; canAdd: boolean }) {
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
  // a step's settings are Settings → AI Editor; another plug-in's, its own section (from its page half, read now)
  const section = row.state === "on" ? "editor" : webPlugins.find((p) => p.id === row.id)?.settings?.find((x) => !x.adminTab)?.id;
  const actions =
    row.state === "on" || row.state === "loaded" ? (
      <>
        <InUse>Installed</InUse>
        {section && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/settings/${section}`}>Settings</Link>
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
