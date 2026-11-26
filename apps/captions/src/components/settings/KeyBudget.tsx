import { useEffect, useState } from "react";
import { BUDGET_NEAR, BUDGET_SERVICES, type KeyBudget, type ServiceUsageView } from "@contracts/service-usage";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { FormDialog } from "./kit-dialog";
import { usd } from "./KeyUsage";

/**
 * A key's monthly budget (api/lib/service-usage.ts): what it spent this month against it, for the whole key and for each
 * workspace on it. Set from the key's `…` menu on Settings → API keys, and offered once a key is added; Usage shows the
 * lines only. At a budget the key's calls stop (in that workspace alone, for a workspace's) until the 1st.
 */

export const canBudget = (service?: string) => !!service && (BUDGET_SERVICES as readonly string[]).includes(service);

export const budgetFor = (view: ServiceUsageView | null, service: string, whose: KeyBudget["whose"]) =>
  view?.budgets?.find((b) => b.service === service && b.whose === whose) ?? null;

/** A key with nothing set and nothing spent yet (just added): what the budget dialog starts from. */
export const emptyBudget = (service: string, whose: KeyBudget["whose"]): KeyBudget => ({ service, whose, budget: null, spent: 0, workspaces: [] });

type Tone = "ok" | "near" | "at";
const toneOf = (spent: number, budget: number | null): Tone => (budget === null ? "ok" : spent >= budget ? "at" : spent >= budget * BUDGET_NEAR ? "near" : "ok");
const TEXT: Record<Tone, string> = { ok: "text-muted-foreground", near: "text-amber-700 dark:text-amber-300", at: "text-red-600 dark:text-red-400" };
const BAR: Record<Tone, string> = { ok: "bg-zinc-400", near: "bg-amber-400", at: "bg-red-500" };

function Meter({ label, spent, budget }: { label: string; spent: number; budget: number | null }) {
  const tone = toneOf(spent, budget);
  return (
    <span className="block w-full max-w-64 text-xs">
      <span className={TEXT[tone]}>{tone === "at" ? `${label}budget reached: stopped until the 1st` : `${label}${usd(spent)}${budget !== null ? ` of $${budget}` : ""} this month`}</span>
      {budget !== null && (
        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", BAR[tone])} style={{ width: `${Math.min(100, Math.max(2, (spent / Math.max(budget, 0.01)) * 100))}%` }} />
        </span>
      )}
    </span>
  );
}

/** The key's month against its budget, and each workspace with a budget on it. Shows only: the budget is set from the key's menu. */
export function BudgetLines({ b }: { b: KeyBudget }) {
  const names = useWorkspace((s) => s.projects);
  const nameOf = (id: string) => names.find((p) => p.id === id)?.name ?? "Workspace";
  return (
    <span className="flex flex-col gap-1">
      <Meter label={b.budget !== null || !b.workspaces.some((w) => w.budget !== null) ? "" : "All: "} spent={b.spent} budget={b.budget} />
      {b.workspaces
        .filter((w) => w.budget !== null)
        .map((w) => (
          <Meter key={w.id} label={`${nameOf(w.id)}: `} spent={w.spent} budget={w.budget} />
        ))}
    </span>
  );
}

export const saveBudget = async (service: string, whose: KeyBudget["whose"], budget: number | null, workspace?: string) => {
  const r = await fetch(`/api/usage/budgets/${encodeURIComponent(service)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ whose, budget, ...(workspace ? { workspace } : {}) }),
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save the budget");
};

/** "" = no limit; else the amount, or undefined when it is not one. */
const parse = (t: string): number | null | undefined => {
  if (t.trim() === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const shown = (n: number | null) => (n === null ? "" : String(n));

/**
 * One key's monthly budgets: the whole key's (or No limit) and each workspace's (empty = no limit of its own), a form with
 * one Save. `offer`: asked right after the key is added, with No budget to leave it unset.
 */
export function BudgetDialog({ name, b, open, onOpenChange, saved, offer }: { name: string; b: KeyBudget; open: boolean; onOpenChange: (open: boolean) => void; saved: () => unknown; offer?: boolean }) {
  const projects = useWorkspace((s) => s.projects);
  const [text, setText] = useState(shown(b.budget));
  const [ws, setWs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wsOf = (id: string) => b.workspaces.find((w) => w.id === id);
  // each open starts from what is saved
  useEffect(() => {
    if (!open) return;
    setText(shown(b.budget));
    setWs(Object.fromEntries(projects.map((p) => [p.id, shown(wsOf(p.id)?.budget ?? null)])));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const all = parse(text);
    if (all === undefined) return setError("Needs an amount in dollars, or nothing for no limit");
    const each = projects.map((p) => [p.id, parse(ws[p.id] ?? "")] as const);
    if (each.some(([, v]) => v === undefined)) return setError("Needs an amount in dollars for each workspace, or nothing");
    setBusy(true);
    setError(null);
    try {
      if (all !== b.budget) await saveBudget(b.service, b.whose, all);
      for (const [id, v] of each) if (v !== (wsOf(id)?.budget ?? null)) await saveBudget(b.service, b.whose, v as number | null, id);
      await saved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={offer ? `Set a monthly budget for ${name}?` : `${name}${b.whose === "server" ? " (server key)" : ""} budget`}
      description="At a budget the tools that use this key stop for the rest of the month."
      submitLabel="Save"
      cancelLabel={offer ? "No budget" : "Cancel"}
      onSubmit={submit}
      busy={busy}
      error={error}
    >
      <label className="flex items-center gap-2 text-sm">
        <span className="w-32 shrink-0">All workspaces</span>
        <span>$</span>
        <Input aria-label="Monthly budget in dollars" inputMode="decimal" placeholder="No limit" value={text} onChange={(e) => setText(e.target.value)} className="w-24" />
        <span className="text-xs text-muted-foreground">{usd(b.spent)} this month</span>
      </label>
      {projects.length > 1 && (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <span className="w-32 shrink-0 truncate">{p.name}</span>
              <span>$</span>
              <Input aria-label={`${p.name} monthly budget in dollars`} inputMode="decimal" placeholder="No limit" value={ws[p.id] ?? ""} onChange={(e) => setWs({ ...ws, [p.id]: e.target.value })} className="w-24" />
              <span className="text-xs text-muted-foreground">{usd(wsOf(p.id)?.spent ?? 0)} this month</span>
            </label>
          ))}
        </div>
      )}
    </FormDialog>
  );
}
