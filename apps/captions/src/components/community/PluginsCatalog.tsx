import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { StepRow, StepsView } from "@contracts/editor-steps";
import { Button } from "@/components/ui/button";
import { Card, EmptyRow, ErrorRow, InUse, ListRow, LoadingRow, saveFailed, Section } from "@/components/settings/ui";
import { addEditStep, getEditSteps } from "@/lib/editor";
import { switchPluginOn } from "@/lib/thisMac";

/**
 * Community → Plug-ins: the plug-ins the Creator Toolset team makes, each one a download. Today these are the AI
 * Editor's post-processing steps (contracts/editor-steps.ts). Download puts the plug-in's folder in the Mac app's
 * plug-ins folder and asks the Mac app to switch it on (its own alert; it then restarts its server and reloads this
 * window). A plug-in that is in adds its own settings (Settings → AI Editor). Only the Mac app on its own server can
 * take one in; elsewhere the list says where to get them.
 */
export function PluginsView({ q }: { q: string }) {
  const [view, setView] = useState<StepsView | null>(null);
  const [error, setError] = useState(false);
  const load = () => getEditSteps().then(setView, () => setError(true));
  useEffect(() => void load(), []);
  if (error && !view) return <Card><ErrorRow title="The plug-ins could not be read" retry={() => { setError(false); void load(); }} /></Card>;
  if (!view) return <Card><LoadingRow /></Card>;
  const s = q.trim().toLowerCase();
  const rows = view.steps.filter((r) => !s || [r.title, r.about].some((v) => v.toLowerCase().includes(s)));
  return (
    <Section title="From the Creator Toolset team">
      <Card>
        {!view.canAdd && rows.every((r) => r.state === "on") && rows.length === 0 ? (
          <EmptyRow title="Plug-ins download into the Creator Toolset Mac app" />
        ) : rows.length === 0 ? (
          <EmptyRow title="Nothing matches your search." />
        ) : (
          rows.map((r) => <PluginRow key={r.folder ?? r.id} row={r} canAdd={view.canAdd} />)
        )}
      </Card>
    </Section>
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
  const actions =
    row.state === "on" ? (
      <>
        <InUse>Installed</InUse>
        <Button asChild size="sm" variant="outline">
          <Link to="/settings/editor">Settings</Link>
        </Button>
      </>
    ) : canAdd ? (
      <Button size="sm" disabled={busy} onClick={() => void download()}>
        {row.state === "add" ? "Download" : "Switch on"}
      </Button>
    ) : undefined;
  return <ListRow title={row.title} subtitle={row.about} status="AI Editor step" actions={actions} />;
}
