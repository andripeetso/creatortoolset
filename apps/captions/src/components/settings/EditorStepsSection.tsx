import type { StepRow } from "@contracts/editor-steps";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsSelect, TextField } from "./ui";

/**
 * One loaded AI Editor step on Settings → Tools → AI Editor: its switch for new edits and, while it is used, its own
 * options. An edit keeps the steps it was made with.
 */
export function StepRowView({ step: s, onChange }: { step: StepRow; onChange: (c: { use?: boolean; values?: Record<string, string> }) => unknown }) {
  return (
    <Row title={s.title} description={s.about} control={<Switch checked={s.use} aria-label={`${s.title} in new edits`} onCheckedChange={(use) => onChange({ use })} />}>
      {s.use && (s.options ?? []).map((o) =>
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
