import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Laptop, Monitor, Server } from "lucide-react";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, type Balance } from "@contracts/providers";
import type { ServerWorkView } from "@contracts/work";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, ListRow, Row, saveFailed, Section, SettingsSelect } from "./ui";
import type { Listed } from "./computers-group";

/**
 * Where video work runs (api/work/server-work.ts, PRD 4.1 and 4.5): the admin's switch for this server (Settings →
 * Storage), the person's Load balancing over every place they may use (Settings → Devices), and a workspace's own
 * choice (its form).
 */

/** The key the server's row saves under in Load balancing (api/work/server-work.ts SERVER_PLACE). */
const SERVER_PLACE = "server";

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !j) throw new Error(j?.error ?? "Could not save");
  return j;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Storage, an admin of a server by address: whether this server does video work, and for which workspaces. */
export function ServerWorkSection() {
  const [view, setView] = useState<ServerWorkView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => call<ServerWorkView>("/api/work/server-work").then(setView, () => setFailed(true)), []);
  useEffect(() => void load(), [load]);
  if (failed && !view)
    return (
      <Section title="Video work">
        <Card>
          <ErrorRow title="Could not load video work" retry={() => (setFailed(false), void load())} />
        </Card>
      </Section>
    );
  const a = view?.admin;
  if (!a) return null;
  const save = (body: { on: boolean } | { all: true } | { only: string[] }) =>
    call<NonNullable<ServerWorkView["admin"]>>("/api/work/server-work", body).then((next) => setView((v) => (v ? { ...v, admin: next } : v)), (e) => saveFailed(msg(e)));
  const on = (w: { on: boolean }) => a.all || w.on;
  return (
    <Section title="Video work">
      <Card>
        <Row
          title="Video work on this server"
          description="Cuts, previews, proxies, waveforms and transcripts can run on this server, after each person's own computers."
          control={<Switch checked={a.on} aria-label="Video work on this server" onCheckedChange={(v) => void save({ on: v })} />}
        />
        {a.on && a.workspaces.length > 0 && (
          <>
            <Row
              title="All workspaces"
              description="Includes workspaces added later."
              control={
                <Switch
                  checked={a.all}
                  aria-label="Video work for all workspaces"
                  // off keeps every workspace on, so nothing stops until one is switched off
                  onCheckedChange={(all) => void save(all ? { all: true } : { only: a.workspaces.map((w) => w.id) })}
                />
              }
            />
            {a.workspaces.map((w) => (
              <Row
                key={w.id}
                title={w.name}
                description={w.owner}
                control={
                  <Switch
                    checked={on(w)}
                    aria-label={`Video work for ${w.name}`}
                    onCheckedChange={(v) => void save({ only: a.workspaces.filter((x) => (x.id === w.id ? v : on(x))).map((x) => x.id) })}
                  />
                }
              />
            ))}
          </>
        )}
      </Card>
    </Section>
  );
}

/**
 * Settings → Computers → Load balancing: every place the person may use, their computers that do video work first, then
 * this server where it works for them, each with the same preference. Prefer on the server sends work there first.
 * Shown with two places or more (one has nothing to balance). Changes save at once.
 */
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
  if (!balance || workers.length + (server ? 1 : 0) < 2) return null;

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
        {workers.map((d) => row(d.id, d.name, d.report?.machine?.os === "mac" || !d.report?.machine ? <Laptop className="size-4" /> : <Monitor className="size-4" />, d.online ? undefined : "Offline"))}
        {server && row(SERVER_PLACE, "This server", <Server className="size-4" />, "After your computers, unless set to Prefer")}
      </Card>
    </Section>
  );
}

/** Under a workspace's form, a card of its own (it saves when picked): where its video work runs, offered only where this server allows video work for it. */
export function WorkspaceServerWork({ projectId }: { projectId: string }) {
  const [state, setState] = useState<{ allowed: boolean; server: boolean } | null>(null);
  useEffect(() => void call<{ allowed: boolean; server: boolean }>(`/api/work/server-work/workspace/${encodeURIComponent(projectId)}`).then(setState, () => {}), [projectId]);
  if (!state?.allowed) return null;
  const pick = (server: boolean) =>
    server !== state.server &&
    void call<{ allowed: boolean; server: boolean }>(`/api/work/server-work/workspace/${encodeURIComponent(projectId)}`, { server }).then(setState, (e) => saveFailed(msg(e)));
  const options = [
    { value: "computers", label: "Your computers" },
    { value: "server", label: "Your computers, then this server" },
  ];
  return (
    <Card>
      <Row
        title="Video work"
        control={<SettingsSelect label="Video work" value={state.server ? "server" : "computers"} onValueChange={(v) => pick(v === "server")} options={options} />}
      />
    </Card>
  );
}
