import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Pencil, Play, Plus } from "lucide-react";
import { AUTOMATION_NAME_MAX, AUTOMATION_PROMPT_MAX, DAY_NAMES, type AutomationResult, type Weekday } from "@contracts/automations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  blankDraft,
  cadenceOf,
  createAutomation,
  deleteAutomation,
  draftBody,
  draftOf,
  draftSchedule,
  listAutomations,
  runAutomationNow,
  updateAutomation,
  type AutomationDraft,
  type AutomationView,
} from "@/lib/automations";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { fmtAgo, msg } from "./helpers";

const RELOAD_MS = 15_000; // a run in progress finishes here without a reload
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const WORD: Record<AutomationResult["status"], string> = { done: "Done", error: "Failed", skipped: "Skipped" };

/** "Mon 16 Nov 09:00": when the next run is, on the task's own clock (the cadence above is on that clock too). */
const nextLabel = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)).replace(",", "");

const firstLine = (text: string) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
};

/** The cadence and the next run; the zone is named only when it is not this browser's, and never for an every-N-hours task. */
const subtitleOf = (a: AutomationView) => {
  if (a.running) return "Running now";
  const where = a.schedule.kind !== "hours" && a.timezone !== zone() ? ` (${a.timezone})` : "";
  const cadence = `${cadenceOf(a.schedule)}${where}`;
  if (!a.enabled) return `${cadence} · off`;
  return a.nextRun ? `${cadence} · next ${nextLabel(a.nextRun, a.timezone)}` : cadence;
};

/** The last result on one line: red when it failed, amber when it was skipped (the person has to fix something). A failed or skipped result's words are below the row. */
function lastLine(a: AutomationView): ReactNode {
  const r = a.lastResult;
  if (!r) return "Not run yet";
  if (r.status === "done") return `${WORD[r.status]} ${fmtAgo(r.at)}: ${firstLine(r.text)}`;
  return <Status tone={r.status === "error" ? "broken" : "attention"}>{`${WORD[r.status]} ${fmtAgo(r.at)}`}</Status>;
}

/**
 * Settings → Scheduled tasks: a prompt the account's AI runs on a schedule. The page builds none while no AI can run one
 * (the server says why: `blocked`). A task's result shows on its row; a failed or skipped one shows its full text below.
 */
export function AutomationsSection() {
  const navigate = useNavigate();
  const [list, setList] = useState<{ items: AutomationView[]; blocked: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "new", a task to edit, or nothing open
  const [editing, setEditing] = useState<AutomationView | "new" | null>(null);

  const reload = () =>
    listAutomations()
      .then((r) => {
        setList(r);
        setError(null);
      })
      .catch((e) => setError(msg(e)));

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), RELOAD_MS);
    return () => clearInterval(t);
  }, []);

  const items = list?.items ?? [];
  const blocked = list?.blocked ?? null;

  return (
    <>
      <Section
        id="scheduled-tasks"
        title="Scheduled tasks"
        action={
          list && !blocked ? (
            <Button size="xs" variant="ghost" onClick={() => setEditing("new")}>
              <Plus className="size-3" /> New task
            </Button>
          ) : null
        }
      >
        <Card>
          {!list ? (
            error ? (
              <ErrorRow title="Could not load scheduled tasks" detail={error} retry={() => void reload()} />
            ) : (
              <LoadingRow title="Loading scheduled tasks…" />
            )
          ) : (
            <>
              {blocked && (
                <Row
                  title="Tasks can't run yet"
                  status={<Status tone="attention">{blocked}</Status>}
                  control={
                    <Button size="sm" variant="outline" onClick={() => navigate("/settings/providers")}>
                      Open Providers
                    </Button>
                  }
                />
              )}
              {!blocked && items.length === 0 && (
                <EmptyRow title="No scheduled tasks" description="A task is a prompt your AI runs on its own, daily, weekly or every few hours. Its last result shows on its row." />
              )}
              {items.map((a) => (
                <TaskRow key={a.id} a={a} onEdit={() => setEditing(a)} onChanged={reload} />
              ))}
            </>
          )}
        </Card>
      </Section>
      {editing && (
        <TaskDialog
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function TaskRow({ a, onEdit, onChanged }: { a: AutomationView; onEdit: () => void; onChanged: () => Promise<void> }) {
  const r = a.lastResult;
  return (
    <div>
      <ListRow
        title={a.name}
        subtitle={subtitleOf(a)}
        status={lastLine(a)}
        actions={
          <>
            <Switch
              checked={a.enabled}
              onCheckedChange={(on) => updateAutomation(a.id, { enabled: on }).then(onChanged).catch((e) => saveFailed(msg(e)))}
              aria-label={`Turn ${a.name} on or off`}
            />
            <RowMenu
              label={`Actions for ${a.name}`}
              items={[
                { label: "Edit", icon: <Pencil />, onSelect: onEdit },
                ...(a.running ? [] : [{ label: "Run now", icon: <Play />, onSelect: () => runAutomationNow(a.id).then(onChanged) }]),
                {
                  label: "Delete",
                  destructive: true,
                  confirm: { title: `Delete “${a.name}”?`, body: "Its schedule and last result are removed.", ok: "Delete" },
                  onSelect: () => deleteAutomation(a.id).then(onChanged),
                },
              ]}
            />
          </>
        }
      />
      {r && r.status !== "done" && <p className="px-3 pb-2.5 text-xs break-words text-muted-foreground sm:px-4">{r.text}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {children}
    </div>
  );
}

/** New or edit. The fields are the server's: name, prompt, schedule, time zone (the browser's, as the server checks it). */
function TaskDialog({ initial, onClose, onSaved }: { initial: AutomationView | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<AutomationDraft>(() => (initial ? draftOf(initial) : blankDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<AutomationDraft>) => setD((cur) => ({ ...cur, ...patch }));
  const timed = d.kind !== "hours";
  // the zone of a task that was made elsewhere shows only when it differs from this browser's
  const elsewhere = initial && initial.timezone !== zone() ? initial.timezone : null;

  const save = async () => {
    if (!d.name.trim() || !d.prompt.trim()) {
      setError("Give the task a name and say what it should do.");
      return;
    }
    if (!timed && !(Number.isInteger(d.every) && d.every >= 1 && d.every <= 168)) {
      setError("Every: a whole number of hours, from 1 to 168.");
      return;
    }
    setBusy(true);
    setError(null);
    // a new task runs on this browser's clock; an edit keeps its own zone
    const body = draftBody(d, initial?.timezone ?? zone());
    try {
      if (!initial) await createAutomation({ ...body, enabled: true });
      else {
        // a changed schedule counts from now (the server's rule); a name or prompt edit must not move the next run
        const same = JSON.stringify(draftSchedule(d)) === JSON.stringify(initial.schedule);
        await updateAutomation(initial.id, same ? { name: body.name, prompt: body.prompt } : body);
      }
      onSaved();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial ? "Edit scheduled task" : "New scheduled task"}
      submitLabel={initial ? "Save task" : "Create task"}
      onSubmit={save}
      busy={busy}
      error={error}
    >
      <Field label="Name">
        <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Monday hooks" maxLength={AUTOMATION_NAME_MAX} aria-label="Name" className="h-8" />
      </Field>
      <Field label="What should it do?">
        <Textarea value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={4} maxLength={AUTOMATION_PROMPT_MAX} aria-label="What should it do?" className="text-sm" />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Repeat">
          <SettingsSelect
            label="Repeat"
            value={d.kind}
            onValueChange={(v) => set({ kind: v as AutomationDraft["kind"] })}
            options={[
              { value: "daily", label: "Every day" },
              { value: "weekly", label: "Every week" },
              { value: "hours", label: "Every N hours" },
            ]}
            className="sm:w-32"
          />
        </Field>
        {d.kind === "weekly" && (
          <Field label="Day">
            <SettingsSelect
              label="Day"
              value={String(d.weekday)}
              onValueChange={(v) => set({ weekday: Number(v) as Weekday })}
              options={DAY_NAMES.map((n, i) => ({ value: String(i), label: n }))}
              className="sm:w-32"
            />
          </Field>
        )}
        {timed ? (
          <Field label="Time">
            <Input type="time" value={d.at} onChange={(e) => set({ at: e.target.value })} aria-label="Time" className="h-8 w-28" />
          </Field>
        ) : (
          <Field label="Hours">
            <Input type="number" min={1} max={168} value={d.every} onChange={(e) => set({ every: Number(e.target.value) })} aria-label="Hours" className="h-8 w-24" />
          </Field>
        )}
      </div>
      {elsewhere && <p className="text-xs text-muted-foreground">Runs in the {elsewhere} time zone.</p>}
    </FormDialog>
  );
}
