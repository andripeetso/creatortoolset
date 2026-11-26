import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Server } from "lucide-react";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, type Balance } from "@contracts/providers";
import type { ServerWorkView } from "@contracts/work";
import { Switch } from "@/components/ui/switch";
import { ErrorRow, ListRow, Row, saveFailed, SettingsSelect, markSave } from "./ui";

/**
 * Where video work runs (api/work/server-work.ts): the person's Load balancing over every place they may use (Settings →
 * Computers). The admin's switches are Settings → Video work (VideoWorkSection.tsx).
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
 * What Off means, under a computer set to it: no work at all, even when no other computer could take it. Exported for
 * a plug-in's own rows under the Computers card too: removing it breaks the build of a server with such a plug-in.
 */
export const OFF_LINE = "Off — takes no work";
/** Sent on window when the Load balancing switch changes (detail: the saved Balance), so a plug-in's rows under the card follow it. */
export const BALANCE_EVENT = "ct-balance";

/**
 * Settings → Computers, Load balancing: no list of its own. `preference(ids, name)` is the select a computer's row in the
 * Computers card carries, shown while the switch is on: it shows the first record's value and saves all of them, so the
 * caller puts the record that speaks for the computer first. `off(ids)`: that row says OFF_LINE. `rows` are the card's last
 * rows: This server where it works for the person (Prefer sends work there first), then the switch. Saves at once.
 */
export function useLoadBalancing() {
  const [view, setView] = useState<ServerWorkView | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    Promise.all([call<ServerWorkView>("/api/work/server-work"), call<Balance>("/api/devices/balance")]).then(([v, b]) => (setView(v), setBalance(b)), (e) => setError(msg(e)));
  }, []);
  useEffect(() => load(), [load]);

  const server = view?.place?.allowed ? view.place : null;
  const weightOf = (id: string) => {
    const v = id === SERVER_PLACE ? (server?.weight ?? DEFAULT_WEIGHT) : (balance?.weights[id] ?? DEFAULT_WEIGHT);
    return LOAD_PREFERENCES.some((p) => p.value === v) ? v : DEFAULT_WEIGHT;
  };
  const save = (ids: string[], v: number) =>
    markSave(call<Balance>("/api/devices/balance", { weights: Object.fromEntries(ids.map((id) => [id, v])) })).then(
      (b) => (setBalance(b), ids.includes(SERVER_PLACE) && setView((cur) => (cur?.place ? { ...cur, place: { ...cur.place, weight: v } } : cur))),
      (e) => saveFailed(msg(e)),
    );
  const preference = (ids: string[], name: string): ReactNode =>
    balance?.on && ids.length ? (
      <SettingsSelect
        label={`${name} load preference`}
        value={String(weightOf(ids[0]))}
        onValueChange={(v) => void save(ids, Number(v))}
        options={LOAD_PREFERENCES.map((p) => ({ value: String(p.value), label: p.label }))}
        className="w-32 sm:w-32 sm:min-w-0"
      />
    ) : null;
  const off = (ids: string[]) => !!balance?.on && ids.length > 0 && weightOf(ids[0]) === 0;
  const rows: ReactNode =
    error && !balance ? (
      <ErrorRow title="Could not load Load balancing" detail={error} retry={load} />
    ) : balance ? (
      <>
        {balance.on && server && <ListRow icon={<Server className="size-4" />} title="This server" subtitle="After your computers, unless set to Prefer" actions={preference([SERVER_PLACE], "This server")} />}
        <Row
          title="Load balancing"
          description="New jobs start on the computer with the most free CPU and memory."
          control={<Switch checked={balance.on} aria-label="Load balancing" onCheckedChange={(on) => void markSave(call<Balance>("/api/devices/balance", { on })).then((b) => (setBalance(b), window.dispatchEvent(new CustomEvent(BALANCE_EVENT, { detail: b }))), (e) => saveFailed(msg(e)))} />}
        />
      </>
    ) : null;
  return { preference, off, rows };
}
