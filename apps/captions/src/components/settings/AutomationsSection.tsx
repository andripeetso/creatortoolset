import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Pencil, Play, Plus } from "lucide-react";
import { AUTOMATION_NAME_MAX, AUTOMATION_PROMPT_MAX, type Destination, type Weekday } from "@contracts/automations";
import { EFFORTS, type Effort, type LimitsIdentity, type ProviderInstance, type ProvidersView, type Selection } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  WEEK,
  blankDraft,
  createAutomation,
  deleteAutomation,
  draftBody,
  draftError,
  draftOf,
  listAutomations,
  runAutomationNow,
  statusOf,
  updateAutomation,
  type AutomationDraft,
  type AutomationView,
  type ScheduleMode,
} from "@/lib/automations";
import { activeSet, effectiveSelection, effortLabel, modelName, modelsOf, useProviders } from "@/lib/providers";
import { useCachedLoad } from "@/lib/local-cache";
import { claudeLimitReset } from "@/lib/limits";
import { listProjects, type WorkshopProject } from "@/lib/workshop";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { msg } from "./helpers";

/** This window's own saves read the list again too: the read after a save is never one that started before it. */
const OWN_TOO = { own: true };
const TICK_MS = 30_000; // "Next run in 5 min" counts down; the list itself is read again only when it changes
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const DESTINATION: Record<Destination, { label: string; detail: string }> = {
  new_chat: { label: "New chat each run", detail: "Each run starts a new assistant chat, named after the task." },
  continue: { label: "One chat, continuing the conversation", detail: "Each run posts in one chat and carries on its conversation." },
  fresh: { label: "One chat, fresh each run", detail: "Each run posts in one chat, without the earlier runs' context." },
};

/** The AIs a task can run on: Claude Code (the one that has the app's tools), switched on, on a computer. */
function taskAis(view: ProvidersView): ProviderInstance[] {
  const sets = [view.own, view.workspace?.editable ? view.workspace.settings : null];
  return sets.flatMap((s) => s?.instances ?? []).filter((i) => i.enabled && i.driver === "claude" && !!i.device);
}

const deviceLabel = (view: ProvidersView, id: string) => {
  const d = view.devices.find((x) => x.id === id);
  return d ? `${d.name}${d.online ? "" : " (offline)"}` : "A removed computer";
};

/** What a new task runs on: the assistant's default when it can run one, else the first AI that can. */
function defaultAi(view: ProvidersView, ais: ProviderInstance[]): Selection | null {
  const set = activeSet(view)?.settings;
  if (set && ais.some((i) => i.id === set.default.instance)) return set.default;
  const first = ais[0];
  if (!first) return null;
  const s = effectiveSelection(set ?? view.own ?? view.workspace!.settings, first, modelsOf(view, first));
  return { instance: first.id, ...s };
}

/**
 * Settings → Scheduled tasks: a prompt the account's AI runs on its own, each run a turn in an assistant chat. The page
 * builds none while no AI can run one (the server says why: `blocked`). ?task=<id> opens that task's form.
 * The list is its saved copy at once; a run that starts, ends or is skipped is told by the server (api/automations.ts),
 * so the row follows it without a reload.
 */
export function AutomationsSection() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tasks = useCachedLoad<{ items: AutomationView[]; blocked: string | null }>("/api/automations", listAutomations, OWN_TOO);
  const list = tasks.data;
  const error = tasks.error;
  // the providers give the form its computers and AIs, and the row its usage-limit reset; a failed read leaves those out
  const providers = useProviders().data;
  const [now, setNow] = useState(() => Date.now());
  // "new", a task to edit, or nothing open
  const [editing, setEditing] = useState<AutomationView | "new" | null>(null);

  const refresh = tasks.refresh;
  const reload = useCallback(() => refresh().then(() => setNow(Date.now()), () => {}), [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // a link to one task (the assistant's card, a run's chat) opens its form once the list is in
  const linked = params.get("task");
  const open = editing ?? list?.items.find((x) => x.id === linked) ?? null;
  const close = () => {
    setEditing(null);
    if (linked) setParams((p) => (p.delete("task"), p), { replace: true });
  };

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
              {!blocked && items.length === 0 && <EmptyRow title="No scheduled tasks" />}
              {items.map((a) => (
                <TaskRow key={a.id} a={a} limits={providers?.limits ?? []} now={now} onEdit={() => setEditing(a)} onChanged={reload} />
              ))}
            </>
          )}
        </Card>
      </Section>
      {open && providers && (
        <TaskDialog
          key={open === "new" ? "new" : open.id}
          initial={open === "new" ? null : open}
          providers={providers}
          onClose={close}
          onSaved={() => {
            close();
            void reload();
          }}
        />
      )}
    </>
  );
}

function TaskRow({ a, limits, now, onEdit, onChanged }: { a: AutomationView; limits: LimitsIdentity[]; now: number; onEdit: () => void; onChanged: () => Promise<void> }) {
  const runNow = () => runAutomationNow(a.id).then(onChanged).catch((e) => saveFailed(msg(e)));
  // the chat its runs post in, or for a new-chat task the last run's
  const chat = a.chat ?? a.lastResult?.chat;
  const { line, problem } = statusOf(a, now, claudeLimitReset(limits, now));
  return (
    <ListRow
      title={a.name}
      subtitle={<span className="line-clamp-2 whitespace-normal">{a.prompt}</span>}
      status={
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{line}</span>
          {problem && <Status tone={problem.tone}>{problem.text}</Status>}
          {chat && (
            <Link to={`/?chat=${encodeURIComponent(chat)}`} className="w-fit underline underline-offset-2 hover:text-foreground">
              {a.destination === "new_chat" ? "Open the last run's chat" : "Open its chat"}
            </Link>
          )}
        </span>
      }
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
              ...(a.running ? [] : [{ label: "Run now", icon: <Play />, onSelect: runNow }]),
              {
                label: "Delete",
                destructive: true,
                confirm: { title: `Delete “${a.name}”?`, body: "It stops at once. Its chats stay.", ok: "Delete" },
                onSelect: () => deleteAutomation(a.id).then(onChanged),
              },
            ]}
          />
        </>
      }
    />
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const MODES: { value: ScheduleMode; label: string }[] = [
  { value: "fixed", label: "At a time" },
  { value: "once", label: "Once" },
  { value: "interval", label: "Every interval" },
];

/** New or edit: every field here is read by the run (api/automations.ts readiness, runAutomation). */
function TaskDialog({ initial, providers, onClose, onSaved }: { initial: AutomationView | null; providers: ProvidersView; onClose: () => void; onSaved: () => void }) {
  const ais = useMemo(() => taskAis(providers), [providers]);
  const [d, setD] = useState<AutomationDraft>(() => {
    const ai = initial?.ai ?? (initial ? null : defaultAi(providers, ais));
    const device = ais.find((i) => i.id === ai?.instance)?.device ?? ais[0]?.device ?? "";
    return initial ? draftOf(initial, device) : { ...blankDraft(), ai, device };
  });
  const [projects, setProjects] = useState<WorkshopProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<AutomationDraft>) => setD((cur) => ({ ...cur, ...patch }));

  useEffect(() => {
    listProjects().then(setProjects, () => {});
  }, []);

  const devices = [...new Set(ais.map((i) => i.device!))];
  const here = ais.filter((i) => i.device === d.device);
  const models = here.flatMap((inst) => modelsOf(providers, inst).map((m) => ({ inst, m })));
  // the stored AI is listed even when it can't run any more, so the form says what the task has
  const aiKey = d.ai ? `${d.ai.instance}\n${d.ai.model}` : "";
  const modelOptions = models.map(({ inst, m }) => ({ value: `${inst.id}\n${m}`, label: here.length > 1 ? `${inst.name} · ${modelName(m)}` : modelName(m) }));
  if (d.ai && !modelOptions.some((o) => o.value === aiKey)) modelOptions.unshift({ value: aiKey, label: `${modelName(d.ai.model)} (not available)` });

  const pickDevice = (device: string) => {
    const inst = ais.find((i) => i.device === device);
    const m = inst ? modelsOf(providers, inst)[0] : undefined;
    set({ device, ai: inst && m ? { instance: inst.id, model: m, effort: d.ai?.effort ?? "high" } : null });
  };

  const save = async () => {
    const problem = draftError(d);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      // a new task runs on this browser's clock; an edit keeps its own zone
      const body = draftBody(d, initial?.timezone ?? zone());
      if (!initial) await createAutomation(body);
      else {
        // an unchanged schedule must not move the next run (a new one counts from now: the server's rule)
        const { schedule, ...rest } = body;
        await updateAutomation(initial.id, JSON.stringify(schedule) === JSON.stringify(initial.schedule) ? rest : body);
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
      title={initial ? "Edit task" : "New task"}
      description="Run a prompt automatically on an interval, at a fixed time, or once at a set date. Each run and its answer land in an assistant chat."
      submitLabel={initial ? "Save task" : "Create task"}
      onSubmit={save}
      wide
      busy={busy}
      error={error}
    >
      <Field label="Runs on">
        <SettingsSelect
          label="Runs on"
          value={d.device}
          onValueChange={pickDevice}
          options={(devices.includes(d.device) || !d.device ? devices : [d.device, ...devices]).map((id) => ({ value: id, label: deviceLabel(providers, id) }))}
          className="sm:w-full"
        />
      </Field>
      <Field label="Name">
        <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Monday hook ideas" maxLength={AUTOMATION_NAME_MAX} aria-label="Name" className="h-8" />
      </Field>
      <Field label="Destination" hint={DESTINATION[d.destination].detail}>
        <SettingsSelect
          label="Destination"
          value={d.destination}
          onValueChange={(v) => set({ destination: v as Destination })}
          options={(Object.keys(DESTINATION) as Destination[]).map((k) => ({ value: k, label: DESTINATION[k].label }))}
          className="sm:w-full"
        />
      </Field>
      <Field label="Project">
        <SettingsSelect
          label="Project"
          value={d.project || "none"}
          onValueChange={(v) => set({ project: v === "none" ? "" : v })}
          options={[{ value: "none", label: "No project" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          className="sm:w-full"
        />
      </Field>
      <Field label="Prompt">
        <Textarea
          value={d.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={4}
          maxLength={AUTOMATION_PROMPT_MAX}
          placeholder="What should the AI do each time this runs?"
          aria-label="Prompt"
          className="text-sm"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Model">
          <SettingsSelect
            label="Model"
            value={aiKey}
            onValueChange={(v) => {
              const [instance, model] = v.split("\n") as [string, string];
              set({ ai: { instance, model, effort: d.ai?.effort ?? "high" } });
            }}
            options={modelOptions}
            disabled={!modelOptions.length}
            className="sm:w-full"
          />
        </Field>
        <Field label="Thinking">
          <SettingsSelect
            label="Thinking"
            value={d.ai?.effort ?? "high"}
            onValueChange={(v) => d.ai && set({ ai: { ...d.ai, effort: v as Effort } })}
            options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
            disabled={!d.ai}
            className="sm:w-32"
          />
        </Field>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium text-foreground">Schedule</div>
          <ToggleGroup type="single" variant="outline" size="sm" value={d.mode} onValueChange={(v) => v && set({ mode: v as ScheduleMode })} aria-label="Schedule type">
            {MODES.map((m) => (
              <ToggleGroupItem key={m.value} value={m.value} className="px-2.5 text-xs">
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {d.mode === "fixed" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Run at</span>
            <Input type="time" value={d.at} onChange={(e) => set({ at: e.target.value })} aria-label="Run at" className="h-8 w-28" />
            <span>on</span>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              value={d.weekdays.map(String)}
              onValueChange={(v) => set({ weekdays: v.map(Number) as Weekday[] })}
              aria-label="Days to run"
            >
              {WEEK.map((w) => (
                <ToggleGroupItem key={w.day} value={String(w.day)} className="px-2 text-xs data-[state=off]:text-muted-foreground data-[state=on]:bg-foreground data-[state=on]:text-background">
                  {w.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
        {d.mode === "once" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Run on</span>
            <Input type="datetime-local" value={d.runAt} onChange={(e) => set({ runAt: e.target.value })} aria-label="Run on" className="h-8 w-52" />
          </div>
        )}
        {d.mode === "interval" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Run every</span>
            <Input type="number" min={1} value={d.every} onChange={(e) => set({ every: Number(e.target.value) })} aria-label="Run every" className="h-8 w-20" />
            <SettingsSelect
              label="Unit"
              value={d.unit}
              onValueChange={(v) => set({ unit: v as AutomationDraft["unit"] })}
              options={[
                { value: "minutes", label: "minutes" },
                { value: "hours", label: "hours" },
              ]}
              className="w-28 sm:min-w-28"
            />
          </div>
        )}
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-foreground">Enabled</div>
          <p className="text-xs text-muted-foreground">Disabled tasks stay saved but do not run.</p>
        </div>
        <Switch checked={d.enabled} onCheckedChange={(on) => set({ enabled: on })} aria-label="Enabled" />
      </div>
    </FormDialog>
  );
}
