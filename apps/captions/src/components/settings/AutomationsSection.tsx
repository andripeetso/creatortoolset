import { useEffect, useState, type ReactNode } from "react";
import { DAY_NAMES, describeSchedule, type Weekday } from "@contracts/automations";
import { Pencil, Plus } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  blankDraft,
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
import { Card, Loading, Notice } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Settings → Automations: each scheduled prompt with its on/off switch, its next run, its last result, Edit, Run now and
 * delete. New automation and Edit open the same form (the body the server's POST and PATCH take).
 */
export function AutomationsSection() {
  const [items, setItems] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "new", an automation to edit, or nothing
  const [editing, setEditing] = useState<AutomationView | "new" | null>(null);

  const reload = () =>
    listAutomations()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => setError(msg(e)));

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 15_000);   // a run in progress finishes here without a reload
    return () => clearInterval(t);
  }, []);

  const act = (fn: () => Promise<unknown>) => fn().then(reload).catch((e) => setError(msg(e)));

  if (!items) return error ? <Notice tone="error">Could not load automations: {error}</Notice> : <Loading />;

  return (
    <div className="space-y-3">
      {!editing && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> New automation
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {editing ? (
        <AutomationForm
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) void reload();
          }}
        />
      ) : items.length === 0 ? (
        <Notice>No automations yet. For example: “every Monday at 9, pull my new Instagram posts and draft three hooks in the Workshop.”</Notice>
      ) : (
        <Card>
          {items.map((a) => (
            <div key={a.id} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">
                    {a.name}
                    {a.running && <span className="ml-2 text-xs text-amber-400">running</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {describeSchedule(a.schedule, a.timezone)}
                    {a.enabled && a.nextRun ? ` · next ${when(a.nextRun)}` : a.enabled ? "" : " · off"}
                  </div>
                </div>
                <Switch checked={a.enabled} onCheckedChange={(on) => void act(() => updateAutomation(a.id, { enabled: on }))} aria-label={`Turn ${a.name} on or off`} />
                <Button variant="outline" size="sm" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
                  <Pencil /> Edit
                </Button>
                <Button variant="outline" size="sm" disabled={a.running} onClick={() => void act(() => runAutomationNow(a.id))}>
                  Run now
                </Button>
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Click again to delete"
                  title="Delete this automation for good"
                  onConfirm={() => act(() => deleteAutomation(a.id))}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-300"
                  armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {a.lastResult ? (
                  <>
                    <span className={a.lastResult.status === "done" ? "text-emerald-400" : a.lastResult.status === "error" ? "text-red-400" : "text-amber-400"}>
                      {a.lastResult.status}
                    </span>
                    {` · ${fmtAgo(a.lastResult.at)}: ${a.lastResult.text.length > 280 ? `${a.lastResult.text.slice(0, 280)}…` : a.lastResult.text}`}
                  </>
                ) : (
                  "Not run yet"
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** The form for a new automation or an edit. Its fields are the server's: name, prompt, schedule, timezone. */
function AutomationForm({ initial, onDone }: { initial: AutomationView | null; onDone: (saved: boolean) => void }) {
  const [d, setD] = useState<AutomationDraft>(() => (initial ? draftOf(initial) : blankDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<AutomationDraft>) => setD((cur) => ({ ...cur, ...patch }));
  const timed = d.kind !== "hours";
  // an empty or out-of-range "Every" reads as 0 (Number("")), so it is blocked here, not sent
  const everyOk = timed || (Number.isInteger(d.every) && d.every >= 1 && d.every <= 168);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = draftBody(d, zone());
    try {
      if (!initial) await createAutomation({ ...body, enabled: true });
      else {
        // a changed schedule counts from now (the server's rule); a name or prompt edit must not move the next run
        const same = JSON.stringify(draftSchedule(d)) === JSON.stringify(initial.schedule);
        await updateAutomation(initial.id, same ? { name: body.name, prompt: body.prompt } : body);
      }
      onDone(true);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-4">
      <Field label="Name">
        <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Monday hooks" maxLength={80} aria-label="Name" className="h-8 max-w-sm text-xs" />
      </Field>
      <Field label="What to do" hint="Runs with no one at the screen, with the chat's tools.">
        <Textarea value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={4} maxLength={4000} aria-label="Prompt" className="text-xs" />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Repeat">
          <select value={d.kind} onChange={(e) => set({ kind: e.target.value as AutomationDraft["kind"] })} aria-label="Repeat" className={`h-8 ${selectCls}`}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="hours">Every N hours</option>
          </select>
        </Field>
        {d.kind === "weekly" && (
          <Field label="Day">
            <select value={d.weekday} onChange={(e) => set({ weekday: Number(e.target.value) as Weekday })} aria-label="Day" className={`h-8 ${selectCls}`}>
              {DAY_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        )}
        {timed ? (
          <Field label="At" hint={`Your time zone: ${zone()}`}>
            <Input type="time" value={d.at} onChange={(e) => set({ at: e.target.value })} aria-label="Time" className="h-8 w-32 text-xs" />
          </Field>
        ) : (
          <Field label="Every" hint="Hours, 1 to 168">
            <Input type="number" min={1} max={168} required value={d.every} onChange={(e) => set({ every: Number(e.target.value) })} aria-label="Hours" className="h-8 w-24 text-xs" />
          </Field>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || !d.name.trim() || !d.prompt.trim() || !everyOk} onClick={() => void save()}>
          {initial ? "Save changes" : "Create automation"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
