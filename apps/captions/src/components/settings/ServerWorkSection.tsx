import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Laptop, Monitor, Server } from "lucide-react";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, type Balance } from "@contracts/providers";
import type { ServerWorkView } from "@contracts/work";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, ListRow, Row, saveFailed, Section, SettingsSelect } from "./ui";
import type { Listed } from "./computers-group";

/**
 * Where video work runs (api/work/server-work.ts): the person's Load balancing over every place they may use (Settings →
 * Computers). The admin's switches are Settings → Workspace policies (WorkspacePoliciesSection.tsx).
 */

/** The key the server's row saves under in Load balancing (api/work/server-work.ts SERVER_PLACE). */
const SERVER_PLACE = "server";

export async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !j) throw new Error(j?.error ?? "Could not save");
  return j;
}

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings → Computers → Load balancing: every place the person may use, their computers that do video work first, then
 * this server where it works for them, each with the same preference. Prefer on the server sends work there first.
 * Its first row, Automatic, turns the whole thing on or off (the preferences only count while it is on, so they are hidden
 * when off). The one Load balancing card: a plug-in adds rows of its own under it without a heading. Shown always, with
 * one place too, so the switch is never missing. Changes save at once.
 */
/** What Off means, under a computer set to it: no work at all, even when no other computer could take it. */
export const OFF_LINE = "Off — takes no work";
/** Sent on window when the Automatic switch changes (detail: the saved Balance), so a plug-in's rows under the card follow it. */
export const BALANCE_EVENT = "ct-balance";

export function LoadBalancing({ computers }: { computers: Listed[] }) {
  const [view, setView] = useState<ServerWorkView | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    Promise.all([call<ServerWorkView>("/api/work/server-work"), call<Balance>("/api/devices/balance")]).then(([v, b]) => (setView(v), setBalance(b)), (e) => setError(msg(e)));
  }, []);
  useEffect(() => load(), [load]);

  const workers = computers.filter((d) => !!d.work);
  const server = view?.place?.allowed ? view.place : null;
  if (error && !balance)
    return (
      <Card>
        <ErrorRow title="Could not load Load balancing" detail={error} retry={load} />
      </Card>
    );
  if (!balance) return null;

  const weightOf = (id: string) => {
    const v = id === SERVER_PLACE ? (server?.weight ?? DEFAULT_WEIGHT) : (balance.weights[id] ?? DEFAULT_WEIGHT);
    return LOAD_PREFERENCES.some((p) => p.value === v) ? v : DEFAULT_WEIGHT;
  };
  const save = (id: string, v: number) =>
    call<Balance>("/api/devices/balance", { weights: { [id]: v } }).then(
      (b) => (setBalance(b), id === SERVER_PLACE && setView((cur) => (cur?.place ? { ...cur, place: { ...cur.place, weight: v } } : cur))),
      (e) => saveFailed(msg(e)),
    );
  const select = (id: string, name: string) => (
    <SettingsSelect
      label={`${name} load preference`}
      value={String(weightOf(id))}
      onValueChange={(v) => void save(id, Number(v))}
      options={LOAD_PREFERENCES.map((p) => ({ value: String(p.value), label: p.label }))}
      className="w-32 sm:w-32 sm:min-w-0"
    />
  );
  const row = (id: string, name: string, icon: ReactNode, subtitle?: string) => <ListRow key={id} icon={icon} title={name} subtitle={subtitle} actions={select(id, name)} />;

  return (
    <Section title="Load balancing">
      <Card>
        <Row
          title="Automatic"
          description="New jobs start on the computer with the most free CPU and memory."
          control={<Switch checked={balance.on} aria-label="Automatic" onCheckedChange={(on) => void call<Balance>("/api/devices/balance", { on }).then((b) => (setBalance(b), window.dispatchEvent(new CustomEvent(BALANCE_EVENT, { detail: b }))), (e) => saveFailed(msg(e)))} />}
        />
        {balance.on && workers.map((d) => row(d.id, d.name, d.report?.machine?.os === "mac" || !d.report?.machine ? <Laptop className="size-4" /> : <Monitor className="size-4" />, weightOf(d.id) === 0 ? OFF_LINE : d.online ? undefined : "Offline"))}
        {balance.on && server && row(SERVER_PLACE, "This server", <Server className="size-4" />, "After your computers, unless set to Prefer")}
      </Card>
    </Section>
  );
}
