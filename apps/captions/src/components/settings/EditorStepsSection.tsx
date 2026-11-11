import { useEffect, useState } from "react";
import type { StepRow, StepsView } from "@contracts/editor-steps";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { addEditStep, getEditSteps, setEditStep } from "@/lib/editor";
import { switchPluginOn } from "@/lib/thisMac";
import { Card, ErrorRow, LoadingRow, Row, saveFailed, Section, SettingsSelect, TextField } from "./ui";

/**
 * Settings → AI Editor: the post-processing steps every new edit goes through (contracts/editor-steps.ts). A step that
 * comes with the app is a plug-in: Turn on puts its folder in the plug-ins folder and asks the Mac app to switch it on
 * (the Mac app's own alert; it then restarts its server and reloads this window). A step that is on has a switch for
 * new edits and its options. An edit keeps the steps it was made with.
 */
export function EditorStepsSection() {
  const [view, setView] = useState<StepsView | null>(null);
  const [error, setError] = useState(false);
  const load = () => getEditSteps().then(setView, () => setError(true));
  useEffect(() => void load(), []);
  if (error && !view) return <Card><ErrorRow title="The steps could not be read" retry={() => { setError(false); void load(); }} /></Card>;
  if (!view) return <Card><LoadingRow /></Card>;
  const change = (id: string, c: { use?: boolean; values?: Record<string, string> }) =>
    setEditStep(id, c).then(setView, () => saveFailed("That did not save. Try again."));
  return (
    <Section title="Post-processing">
      <Card>
        {view.steps.map((s) => <StepRowView key={s.id} step={s} onChange={(c) => change(s.id, c)} />)}
      </Card>
    </Section>
  );
}

function StepRowView({ step: s, onChange }: { step: StepRow; onChange: (c: { use?: boolean; values?: Record<string, string> }) => unknown }) {
  const [busy, setBusy] = useState(false);
  const turnOn = async () => {
    setBusy(true);
    try {
      if (s.state === "add") await addEditStep(s.folder!);
      const r = await switchPluginOn(s.folder!);
      if (r && !r.ok && r.problem) saveFailed(r.problem);
    } catch {
      saveFailed(`${s.title} could not be turned on. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  const control =
    s.state === "on" ? (
      <Switch checked={s.use} aria-label={`${s.title} in new edits`} onCheckedChange={(use) => onChange({ use })} />
    ) : (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void turnOn()}>Turn on</Button>
    );
  return (
    <Row title={s.title} description={s.about} control={control}>
      {s.state === "on" && s.use && (s.options ?? []).map((o) =>
        o.kind === "choice" ? (
          <div key={o.id} className="flex items-center justify-between gap-4 py-1 text-sm">
            <span className="text-muted-foreground">{o.label}</span>
            <SettingsSelect label={o.label} value={s.values[o.id] ?? o.default} onValueChange={(v) => onChange({ values: { [o.id]: v } })}
              options={(o.choices ?? []).map((c) => ({ value: c.value, label: c.label }))} />
          </div>
        ) : (
          <TextField key={o.id} label={o.label} value={s.values[o.id] ?? o.default} placeholder={o.placeholder}
            onCommit={(v) => onChange({ values: { [o.id]: v } })} />
        ),
      )}
    </Row>
  );
}
