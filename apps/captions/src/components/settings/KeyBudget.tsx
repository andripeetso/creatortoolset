import { useState } from "react";
import { BUDGET_NEAR, type KeyBudget, type ServiceUsageView } from "@contracts/service-usage";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FormDialog } from "./kit-dialog";
import { usd } from "./KeyUsage";

/**
 * A key's monthly budget (api/lib/service-usage.ts): what it spent this month against it, and the dialog that sets it.
 * At the budget every tool's call on that key stops until the 1st or a higher budget; past BUDGET_NEAR the line turns amber.
 */

export const budgetFor = (view: ServiceUsageView | null, service: string, whose: KeyBudget["whose"]) =>
  view?.budgets?.find((b) => b.service === service && b.whose === whose) ?? null;

/** "This month: $4.20 of $31 budget" over a thin bar, or "This month: $4.20" with no budget. */
export function BudgetLine({ b, onClick }: { b: KeyBudget; onClick: () => void }) {
  const share = b.budget ? b.spent / b.budget : 0;
  const at = b.budget !== null && b.spent >= b.budget;
  const near = b.budget !== null && share >= BUDGET_NEAR;
  return (
    <button type="button" onClick={onClick} className="block w-full max-w-64 text-left text-xs hover:underline">
      <span className={cn(at ? "text-red-600 dark:text-red-400" : near ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
        {at ? "Budget reached: stopped until the 1st" : `This month: ${usd(b.spent)}${b.budget !== null ? ` of $${b.budget} budget` : ""}`}
      </span>
      {b.budget !== null && (
        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", at ? "bg-red-500" : near ? "bg-amber-400" : "bg-zinc-400")} style={{ width: `${Math.min(100, Math.max(2, share * 100))}%` }} />
        </span>
      )}
    </button>
  );
}

export const saveBudget = async (service: string, whose: KeyBudget["whose"], budget: number | null) => {
  const r = await fetch(`/api/usage/budgets/${encodeURIComponent(service)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ whose, budget }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save the budget");
};

/** One key's monthly budget in dollars, or No limit: a form with one Save. */
export function BudgetDialog({ name, b, open, onOpenChange, saved }: { name: string; b: KeyBudget; open: boolean; onOpenChange: (open: boolean) => void; saved: () => unknown }) {
  const [text, setText] = useState(b.budget === null ? "" : String(b.budget));
  const [none, setNone] = useState(b.budget === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const usdValue = Number(text);
    if (!none && (text.trim() === "" || !Number.isFinite(usdValue) || usdValue < 0)) return setError("Needs an amount in dollars");
    setBusy(true);
    setError(null);
    try {
      await saveBudget(b.service, b.whose, none ? null : usdValue);
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
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) {
          setText(b.budget === null ? "" : String(b.budget));
          setNone(b.budget === null);
          setError(null);
        }
      }}
      title={`${name}${b.whose === "server" ? " (server key)" : ""} budget`}
      description="Every tool that uses this key stops for the rest of the month at this amount."
      submitLabel="Save"
      onSubmit={submit}
      busy={busy}
      error={error}
    >
      <p className="text-sm text-muted-foreground">This month: {usd(b.spent)}</p>
      <label className="flex items-center gap-2 text-sm">
        <span>$</span>
        <Input aria-label="Monthly budget in dollars" inputMode="decimal" value={none ? "" : text} disabled={none} onChange={(e) => setText(e.target.value)} className="w-28" />
        <span>a month</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={none} onCheckedChange={(on) => setNone(on === true)} />
        No limit
      </label>
    </FormDialog>
  );
}
