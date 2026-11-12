import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { StepRow, StepsView } from "@contracts/editor-steps";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { addEditStep, getEditSteps, setEditStep } from "@/lib/editor";
import { switchPluginOn } from "@/lib/thisMac";
import { Card, ErrorRow, LoadingRow, Row, saveFailed, Section, SettingsSelect, TextField } from "./ui";

/**
 * Settings → AI Editor: the post-processing steps that are in this app (each a plug-in from Community → Plug-ins), each
 * with a switch for new edits and its own options. A step adds its row when it is downloaded; one that isn't in has no
 * row here. An edit keeps the steps it was made with.
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
  const steps = view.steps.filter((s) => s.state === "on");
  return (
    <Section title="Post-processing">
      <Card>
        {steps.length ? (
          steps.map((s) => <StepRowView key={s.id} step={s} onChange={(c) => change(s.id, c)} />)
        ) : (
          <Row title="No post-processing steps yet" control={<Button asChild size="sm" variant="outline"><Link to="/community/plugins">Get plug-ins</Link></Button>} />
        )}
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
          <div key={o.id} className="flex flex-col gap-1.5 py-1 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span className="text-muted-foreground">{o.label}</span>
            <TextField label={o.label} value={s.values[o.id] ?? o.default} placeholder={o.placeholder} className="w-full sm:w-80"
              onCommit={(v) => onChange({ values: { [o.id]: v } })} />
          </div>
        ),
      )}
    </Row>
  );
}
