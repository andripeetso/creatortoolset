import { groupComputers } from "./computers-group";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import {
  addInstanceTo,
  DRIVERS,
  EFFORTS,
  JOBS,
  runsOn,
  type Driver,
  type ProviderCheck,
  type ProviderInstance,
  type ProviderSettings,
  type ProvidersView,
  type Scope,
  type Selection,
} from "@contracts/providers";
import type { CliId } from "@contracts/local-ai";
import { useAuth } from "@/lib/auth";
import { autoTestDue, checkProvider, deviceOf, effectiveSelection, effortLabel, modelChoices, modelName, modelsOf, saveOwn, saveWorkspace, thisMacDevice, useProviders } from "@/lib/providers";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { msg } from "./helpers";
import { AddProviderDialog } from "./AddProviderDialog";
import { ProviderDetail } from "./ProviderDetail";
import { DriverMark, PROVIDER_ROW, ProviderInstanceCard, providerStatus, withInstance, type ProviderStatus } from "./ProviderInstanceCard";
import { isLocalCli, LocalAiRows, localInstall, localSignIn, useLocalAi } from "./AiSetup";
import { LocalModelRow } from "./LocalModelRow";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, Section, SettingsSelect, saveFailed, Status, StatusDot } from "./ui";
import type { SearchRowId } from "./search";

/** The tools the Mac app can start a sign-in for: in Terminal (the Mac's signInCommands), Muse Code's in the browser. */
const SIGN_IN_DRIVERS: string[] = ["claude", "codex", "grok", "musecode"];
/** The "Default" choice of a job (a select's option needs a value; "" is not allowed). */
const USE_DEFAULT = "use-default";

/**
 * Settings → Providers. The computers that run AI are tabs on top. Under them is one bordered panel: on the left the
 * AI providers on the chosen computer and the tools it has installed and not yet added (each with Add); on the right
 * the chosen provider's settings. Below `lg` the panel shows one or the other (`sub` = the provider's id is its own
 * page). Add provider is beside the section's title. The section is titled "Server providers" while a hosted server's
 * admin with no providers of their own edits the set the server shares. "AI by job" sets the Default and each job's
 * pick, every row open. A member sees what they use: their own providers, or the team budget. On an own-computer
 * install with no Mac app paired, the list is the AI apps found on this computer (the same source as Headless
 * access); its admin also gets the Local model row (LocalModelRow), under the list.
 */
/** "2.1.321" from "2.1.321 (Claude Code)", "codex-cli 0.39.0" or "grok 1.0.4 (d846eb93d94d)": the number a person reads. */
export const shortVersion = (v: string | undefined): string | undefined => v?.match(/\d+(?:\.\d+)+/)?.[0] ?? v;

export function ProvidersSection({ sub }: { sub?: string }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me);
  const hosted = useAuth((s) => s.hosted);
  const isAdmin = me?.role === "admin";
  const providers = useProviders();
  // the change being saved, shown at once: a read that lands meanwhile never puts the old set back
  const [pending, setPending] = useState<ProvidersView | null>(null);
  const saves = useRef(0);
  const view = pending ?? providers.data;
  const setView = providers.set;
  // the computer's own AI apps; on a hosted server the answer is { local: false } and nothing is shown for it
  const local = useLocalAi();
  const localAi = local.data ?? (local.error ? { local: false, rows: [] } : null);
  // the saved copy paints the page; an AI is tested by itself only once this window has read the server
  const [read, setRead] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ driver?: Driver } | null>(null);
  const [params, setParams] = useSearchParams();
  // `?add=1` opens Add provider once, where the page has that button (a computer, and a set this account edits), then the parameter goes
  useEffect(() => {
    if (params.get("add") !== "1" || !view || !me) return;
    if (view.devices.length && (isAdmin || view.own)) setAdding({});
    setParams((p) => (p.delete("add"), p), { replace: true });
  }, [params, setParams, view, me, isAdmin]);
  const [checking, setChecking] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  // the report each AI was last tested for (the page tests an AI once per report)
  const tried = useRef(new Map<string, number>());

  const refreshProviders = providers.refresh;
  const refreshLocal = local.refresh;
  const refreshAll = useCallback(() => {
    void refreshProviders().catch(() => {});
    void refreshLocal().catch(() => {});
  }, [refreshProviders, refreshLocal]);
  useEffect(() => {
    void refreshProviders().then(() => setRead(true), () => {});
  }, [refreshProviders]);

  // A computer coming online and a tool installed or signed in on it reach this page by themselves: its owner's windows
  // (the admins', for the team's own computer) are told "devices" and the saved copy is read again. What nothing tells:
  // a tool set up in Terminal on a computer that reports later, so coming back to the window reads again while the page
  // waits for one.
  const waiting = !!view && !view.devices.some((d) => d.online && d.report?.drivers.some((x) => x.installed));
  const expecting = waiting || !!signingIn;
  useEffect(() => {
    if (!expecting) return;
    window.addEventListener("focus", refreshAll);
    return () => window.removeEventListener("focus", refreshAll);
  }, [expecting, refreshAll]);
  useEffect(() => {
    if (!signingIn || !view) return;
    const found = view.devices.find((d) => d.id === thisMacDevice())?.report?.drivers.find((d) => d.driver === signingIn);
    if (found?.signedIn) setSigningIn(null);
  }, [view, signingIn]);
  useEffect(() => {
    if (!signingIn) return;
    const t = window.setTimeout(() => setSigningIn(null), 180_000);
    return () => window.clearTimeout(t);
  }, [signingIn]);

  // One test at a time, by itself: an AI with nothing on record (or failed since the computer last reported) on an online
  // computer that has the tool. Each AI is tried once per report; a failure waits five minutes before it is tried again.
  const testOne = useCallback(async (scopeKey: string, id: string) => {
    const key = `${scopeKey}:${id}`;
    setChecking(key);
    try {
      const result: ProviderCheck = await checkProvider(scopeKey as Scope, id);
      setView((v) => (v ? { ...v, checks: { ...v.checks, [key]: result } } : v));
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setChecking(null);
    }
  }, [setView]);
  useEffect(() => {
    if (!read || !view || !me || checking) return;
    const ownSet = !isAdmin || !!view.own;
    const set = ownSet ? view.own : (view.workspace?.settings ?? null);
    const scopeKey = ownSet ? me.username : "workspace";
    for (const i of set?.instances ?? []) {
      const device = view.devices.find((d) => d.id === deviceOf(i));
      const report = device?.report;
      if (!device || !report) continue;
      const key = `${scopeKey}:${i.id}`;
      const due = autoTestDue({
        enabled: i.enabled,
        runs: runsOn(i.driver),
        online: device.online,
        reportAt: report.at,
        installed: report.drivers.find((d) => d.driver === i.driver)?.installed,
        check: view.checks[key],
      });
      if (!due || tried.current.get(key) === report.at) continue;
      tried.current.set(key, report.at);
      void testOne(scopeKey, i.id);
      return; // one at a time: the next one starts when this one ends
    }
  }, [read, view, checking, isAdmin, me, testOne]);

  if (!view && providers.error)
    return (
      <Section title="Providers">
        <Card>
          <ErrorRow title="Could not load AI providers" detail={providers.error} retry={refreshAll} />
        </Card>
      </Section>
    );
  if (!view || !me)
    return (
      <Section title="Providers">
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );

  const devices = view.devices;
  // the team's AI answers a member who has none of their own; it is shown, not edited
  const readOnly = !isAdmin && !view.own;
  // The page edits the set that answers this account: its own when it has one (an admin's own answers it first, so the
  // team's set would look empty); otherwise an admin edits the team's. A member's own set is the only one they edit.
  const toOwn = !isAdmin || !!view.own;
  const editing: ProviderSettings | null = toOwn ? view.own : (view.workspace?.settings ?? null);
  const shown: ProviderSettings | null = editing ?? (readOnly ? (view.workspace?.settings ?? null) : null);
  const scope: Scope = toOwn ? me.username : "workspace";
  // the set the server shares (it runs the admins' jobs and the background work) is named, so it is not taken for the admin's own
  const title = hosted && !toOwn ? "Server providers" : "Providers";
  // one tab per Mac: a Mac that paired twice (the app and the worker) is one tab holding the AIs of both records
  const allGroups = groupComputers(devices, me.username);
  // a tab is a computer that can do something here: it is online, or it already holds an AI of this set. A computer that
  // is offline with no AI on it (an old pairing) stays on Settings → Devices, where it can be removed.
  const holdsAi = (ids: string[]) => (editing?.instances ?? []).some((i) => ids.includes(deviceOf(i)));
  const useful = allGroups.filter((g) => g.records.some((r) => r.online) || holdsAi(g.records.map((r) => r.id)));
  const groups = useful.length ? useful : allGroups;
  const tabGroup = groups.find((g) => g.records.some((r) => r.id === tab)) ?? groups[0] ?? null;
  const tabDevice = tabGroup?.primary ?? null;
  const listed = readOnly ? [] : (editing?.instances ?? []).filter((i) => !!tabGroup && tabGroup.records.some((r) => r.id === deviceOf(i)));
  const onDevice = (i: ProviderInstance) => devices.some((d) => d.id === deviceOf(i));
  const orphans = readOnly || !editing ? [] : editing.instances.filter((i) => !onDevice(i));
  const detailInst = readOnly || !editing ? undefined : sub ? editing.instances.find((i) => i.id === sub) : (listed[0] ?? orphans[0]);
  // the right half exists when there is an AI to show there (or the address names one that is gone)
  const twoPane = !!detailInst || !!sub;
  const installedHere = !readOnly && tabDevice?.report ? tabDevice.report.drivers.filter((d) => d.installed && runsOn(d.driver) && !listed.some((i) => i.driver === d.driver)) : [];
  // this computer is the owner's own (an own-computer install): its sign-in and install run here, through the local routes
  const localHere = !!localAi?.local;

  const reportOf = (i: ProviderInstance) => devices.find((d) => d.id === deviceOf(i))?.report ?? null;
  const statusOf = (i: ProviderInstance): ProviderStatus => {
    if (!readOnly && !onDevice(i)) return { tone: "attention", text: "Needs a computer" };
    // while a test runs the status stays what it was: the detail's title says "Testing…" and its help lines stay put
    return providerStatus({
      enabled: i.enabled,
      runs: runsOn(i.driver),
      online: devices.find((d) => d.id === deviceOf(i))?.online ?? true,
      report: !!reportOf(i),
      found: reportOf(i)?.drivers.find((d) => d.driver === i.driver),
      reportAt: reportOf(i)?.at,
      check: view.checks[`${scope}:${i.id}`],
    });
  };
  const usedBy = (id: string): string[] =>
    shown ? [shown.default.instance === id ? "Default" : null, ...JOBS.filter((j) => shown.jobs[j.id]?.instance === id).map((j) => j.label)].filter((x): x is string => !!x) : [];

  // Saves the whole set and shows the change at once. Throws a sentence when it can't save; reverts first.
  const saveSet = async (next: ProviderSettings) => {
    setPending(toOwn ? { ...view, own: next } : view.workspace ? { ...view, workspace: { ...view.workspace, settings: next } } : view);
    saves.current++;
    try {
      if (!toOwn) {
        const saved = await saveWorkspace(next);
        setView((v) => (v && v.workspace ? { ...v, workspace: { ...v.workspace, settings: saved } } : v));
      } else {
        setView(await saveOwn(next));
      }
    } finally {
      // the last save to end drops the override: the saved copy then holds what the server kept (or, after a failure, what it had)
      if (--saves.current === 0) setPending(null);
    }
  };
  const save = (next: ProviderSettings) => saveSet(next).catch((e) => saveFailed(msg(e)));

  // Changes one AI's fields and saves. The Default shows the AI's model and thinking level while it is the Default.
  const patch = (inst: ProviderInstance, p: Partial<ProviderInstance>) => {
    if (!editing) return;
    let next = withInstance(editing, inst.id, p);
    if (editing.default.instance === inst.id && (p.model !== undefined || p.effort !== undefined)) {
      next = { ...next, default: { ...next.default, ...(p.model !== undefined ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) } };
    }
    void save(next);
  };

  const remove = (inst: ProviderInstance) => {
    if (!editing) return;
    navigate("/settings/providers");
    void save({ ...editing, instances: editing.instances.filter((i) => i.id !== inst.id) });
  };

  const runCheck = (inst: ProviderInstance) => testOne(scope, inst.id);

  // The Mac app's bridge (TitleBar.swift, handler "signIn") opens the CLI's sign-in (Terminal, or the browser for Muse Code), then the page re-reads.
  const signIn = (inst: ProviderInstance) => {
    (window as unknown as { webkit?: { messageHandlers?: { signIn?: { postMessage: (m: unknown) => void } } } }).webkit?.messageHandlers?.signIn?.postMessage({
      driver: inst.driver,
      home: inst.home ?? "",
    });
    setSigningIn(inst.driver);
  };
  const canSignIn = (inst: ProviderInstance) => !!thisMacDevice() && deviceOf(inst) === thisMacDevice() && SIGN_IN_DRIVERS.includes(inst.driver);
  // on an own-computer install the app signs in and installs the tool itself (the local routes)
  const signInHere = (inst: ProviderInstance) => {
    setSigningIn(inst.driver);
    void localSignIn(inst.driver as CliId).then((r) => !r.ok && saveFailed(r.message ?? "Could not start the sign-in."), (e) => saveFailed(msg(e)));
  };
  const installHere = async (inst: ProviderInstance) => {
    setInstalling(inst.id);
    try {
      const r = await localInstall(inst.driver as CliId);
      if (!r.ok) saveFailed(r.message ?? "Could not install it.");
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setInstalling(null);
      refreshAll();
    }
  };

  const addAi = async (inst: ProviderInstance) => {
    if (!tabDevice) throw new Error("Needs a computer");
    await saveSet(addInstanceTo(editing, { ...inst, device: tabDevice.id }));
  };

  const openAdd = (driver?: Driver) => {
    if (!tabDevice) navigate("/settings/devices?add=1");
    else setAdding({ driver });
  };

  // What the row's one action is: sign in, install, or test. Only what the app can do here; otherwise the detail says how.
  const detailOpen = (inst: ProviderInstance) => `/settings/providers/${encodeURIComponent(inst.id)}`;
  const actionOf = (inst: ProviderInstance, st: ProviderStatus): ReactNode => {
    if (st.action === "sign-in") {
      if (localHere && isLocalCli(inst.driver)) return <Button size="sm" variant="outline" onClick={() => signInHere(inst)}>Sign in</Button>;
      if (canSignIn(inst)) return <Button size="sm" variant="outline" onClick={() => signIn(inst)}>Sign in</Button>;
      return undefined; // the detail beside the list says how
    }
    if (st.action === "install") {
      if (localHere && isLocalCli(inst.driver))
        return (
          <Button size="sm" variant="outline" disabled={installing === inst.id} onClick={() => void installHere(inst)}>
            {installing === inst.id ? "Installing…" : "Install"}
          </Button>
        );
      return undefined; // the detail beside the list says how
    }
    if (st.action === "test") return <Button size="sm" variant="outline" disabled={checking !== null} onClick={() => void runCheck(inst)}>Test</Button>;
    return undefined;
  };

  // ---- a member: what they use, read-only (their own set is the only one they edit) ----
  if (readOnly) {
    const team = view.teamAi;
    return (
      <Section id="add-provider" title="Providers">
        <Card>
          {team ? (
            <TeamBudgetRow team={team} description="Content Workshop needs an AI provider." onAdd={() => openAdd()} />
          ) : (
            <>
              <EmptyRow title="No AI provider" />
              <div className="px-3 pb-3 sm:px-4">
                <Button size="sm" variant="outline" onClick={() => openAdd()}>
                  <Plus /> Add provider
                </Button>
              </div>
            </>
          )}
        </Card>
      </Section>
    );
  }

  // ---- empty: no computer paired yet ----
  if (devices.length === 0) {
    if (localHere && localAi) {
      return (
        <Section id="add-provider" title={title}>
          <Card>
            <LocalAiRows rows={localAi.rows.filter((r) => r.kind === "cli")} device={thisMacDevice() ?? ""} onChanged={refreshAll} />
          </Card>
          <LocalModelRow />
        </Section>
      );
    }
    if (!localAi) {
      return (
        <Section id="add-provider" title={title}>
          <Card>
            <LoadingRow />
          </Card>
        </Section>
      );
    }
    return (
      <Section id="add-provider" title={title}>
        <Card>
          <EmptyRow title="Needs a computer" />
          <div className="px-3 pb-3 sm:px-4">
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/devices?add=1">Add computer</Link>
            </Button>
          </div>
        </Card>
        <LocalModelRow />
      </Section>
    );
  }

  const nameOf = (id: string) => DRIVERS.find((d) => d.id === id)?.label ?? id;

  return (
    <>
      {groups.length > 1 && (
        <Tabs value={tabDevice?.id ?? ""} onValueChange={(v) => { setTab(v); if (sub) navigate("/settings/providers"); }} className="mb-8">
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {groups.map(({ primary: d }) => (
              <TabsTrigger key={d.id} value={d.id} className="gap-1.5">
                {!d.online && <StatusDot tone="attention" />}
                <span className="max-w-64 truncate">{d.name}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {/* one panel: the list on the left, the chosen provider's settings on the right (below `lg`, one or the other) */}
      <Section
        id="add-provider"
        title={title}
        action={
          <Button size="xs" variant="ghost" onClick={() => openAdd()}>
            <Plus className="size-3" /> Add provider
          </Button>
        }
      >
        <div className={cn("overflow-hidden rounded-xl border border-border/60 bg-card/40 text-foreground", twoPane && "lg:grid lg:grid-cols-[20rem_minmax(0,1fr)]")}>
          <div className={cn("min-w-0 [&>*+*]:border-t [&>*+*]:border-border/50", twoPane && "lg:border-r lg:border-border/50", sub && "hidden lg:block")}>
            {[...listed, ...orphans].map((inst) => (
              <ProviderInstanceCard
                key={inst.id}
                inst={inst}
                status={statusOf(inst)}
                version={shortVersion(reportOf(inst)?.drivers.find((d) => d.driver === inst.driver)?.version)}
                selected={detailInst?.id === inst.id}
                href={detailOpen(inst)}
                action={actionOf(inst, statusOf(inst))}
                onToggle={onDevice(inst) ? (on) => patch(inst, { enabled: on }) : undefined}
              />
            ))}
            {/* the tools this computer has that are not added yet: Add is their one action */}
            {installedHere.map((d) => (
              <ListRow
                key={`installed-${d.driver}`}
                className={PROVIDER_ROW}
                icon={<DriverMark driver={d.driver} />}
                title={
                  <>
                    {nameOf(d.driver)}
                    {d.version && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">v{shortVersion(d.version)}</span>}
                  </>
                }
                actions={
                  <Button size="sm" variant="outline" onClick={() => openAdd(d.driver)} aria-label={`Add ${nameOf(d.driver)}`}>
                    Add
                  </Button>
                }
              />
            ))}
            {listed.length + orphans.length + installedHere.length === 0 && <EmptyRow title="No AI provider" />}
          </div>

          {twoPane && (
            <div className={cn("min-w-0", !sub && "hidden lg:block")}>
              {detailInst && editing ? (
                <ProviderDetail
                  inst={detailInst}
                  status={statusOf(detailInst)}
                  check={view.checks[`${scope}:${detailInst.id}`]}
                  checking={checking === `${scope}:${detailInst.id}`}
                  canTest={(devices.find((d) => d.id === deviceOf(detailInst))?.online ?? true) && checking === null}
                  used={usedBy(detailInst.id)}
                  models={modelsOf(view, detailInst)}
                  selection={effectiveSelection(editing, detailInst, modelsOf(view, detailInst))}
                  computers={!onDevice(detailInst) ? devices.map((d) => ({ id: d.id, name: d.name })) : undefined}
                  computerNote={!onDevice(detailInst) && deviceOf(detailInst) ? "Computer not found" : undefined}
                  backTo="/settings/providers"
                  onChange={(p) => patch(detailInst, p)}
                  onTest={() => void runCheck(detailInst)}
                  onSignIn={statusOf(detailInst).action === "sign-in" && localHere && isLocalCli(detailInst.driver) ? () => signInHere(detailInst) : statusOf(detailInst).action === "sign-in" && canSignIn(detailInst) ? () => signIn(detailInst) : undefined}
                  onMove={onDevice(detailInst) ? undefined : (id) => patch(detailInst, { device: id })}
                  onRemove={() => remove(detailInst)}
                />
              ) : (
                <>
                  <EmptyRow title="Provider not found" />
                  <div className="px-3 pb-3 sm:px-4">
                    <Button asChild size="sm" variant="outline">
                      <Link to="/settings/providers">Back</Link>
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <LocalModelRow />
      </Section>

      {view.teamAi && (
        <div className={cn("mt-8", sub && "hidden lg:block")}>
          <Section title="Team budget">
            <Card>
              <TeamBudgetRow team={view.teamAi} description="Used when no AI provider can run." />
            </Card>
          </Section>
        </div>
      )}

      {shown && (
        <div className={cn("mt-8", sub && "hidden lg:block")}>
          <Section id="tool-ai" title="AI by job">
            <Card>
              <PickRow id="default-ai" title="Default" sel={shown.default} set={shown} listModels={(i) => modelsOf(view, i)} withModel={false} onChange={(v) => v && editing && void save({ ...editing, default: v })} />
              {JOBS.map((j) => (
                <PickRow
                  key={j.id}
                  title={j.label}
                  sel={shown.jobs[j.id]}
                  fallback={shown.default}
                  set={shown}
                  listModels={(i) => modelsOf(view, i)}
                  onChange={(v) => {
                    if (!editing) return;
                    const jobs = { ...editing.jobs };
                    if (v) jobs[j.id] = v;
                    else delete jobs[j.id];
                    void save({ ...editing, jobs });
                  }}
                />
              ))}
            </Card>
          </Section>
        </div>
      )}

      {adding && tabDevice && (
        <AddProviderDialog
          deviceName={tabDevice.name}
          report={tabDevice.report ?? null}
          instances={(editing?.instances ?? []).filter((i) => i.device === tabDevice.id)}
          initialDriver={adding.driver}
          onClose={() => setAdding(null)}
          onAdd={addAi}
        />
      )}
    </>
  );
}

/** Money as the page shows it: "$25", "$14.20". */
const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * The team budget of a member (hosted): what they may spend on the team's API key this month and what they spent. Only
 * their own numbers. `onAdd`: a member with no provider of their own adds one from this row (elsewhere the section has
 * Add provider).
 */
function TeamBudgetRow({ team, description, onAdd }: { team: NonNullable<ProvidersView["teamAi"]>; description: string; onAdd?: () => void }) {
  const status = !team.ready ? (
    <Status tone="attention">Not set up on this server</Status>
  ) : team.left <= 0 ? (
    <Status tone="attention">Used up this month</Status>
  ) : (
    `${money(team.spentUsd)} of ${money(team.budgetUsd)} spent this month`
  );
  return (
    <Row
      title="Team budget"
      description={description}
      status={status}
      control={
        onAdd && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            Add provider
          </Button>
        )
      }
    />
  );
}

/**
 * One pick: an AI provider, and for a job its model and thinking level in two rows under it. `sel` undefined on a job =
 * "Default" (its status names the provider that is). The Default's own model and thinking level are the provider's (in
 * its detail).
 */
function PickRow({
  id,
  title,
  sel,
  fallback,
  set,
  listModels,
  withModel = true,
  onChange,
}: {
  id?: SearchRowId;
  title: string;
  sel?: Selection;
  /** a job's fallback: the Default it uses when it has no pick */
  fallback?: Selection;
  set: ProviderSettings;
  listModels: (i: ProviderInstance) => string[];
  /** a job's pick may set the model and thinking level; the Default's are the provider's own (in its detail) */
  withModel?: boolean;
  onChange: (v: Selection | undefined) => void;
}) {
  const isDefault = !fallback;
  const cur: Selection = sel ?? fallback ?? set.default;
  const inst = set.instances.find((i) => i.id === cur.instance);
  const models = inst ? listModels(inst) : [];
  const pick = (instanceId: string) => {
    const target = set.instances.find((i) => i.id === instanceId);
    const list = target ? listModels(target) : [];
    onChange({ instance: instanceId, model: target?.model ?? list[0] ?? "", effort: target?.effort ?? cur.effort });
  };
  const providers = set.instances.map((i) => ({ value: i.id, label: `${i.name}${i.enabled ? "" : " (off)"}` }));

  const explicit = isDefault || !!sel;
  // the stored model is always offered, even when the tool's list doesn't have it (never swapped for the first one)
  const options = modelChoices(models, cur.model);
  // the two rows under a job's pick end where its own control ends
  const under = "py-1.5 pr-0 sm:pr-0";
  return (
    <Row
      id={id}
      title={title}
      status={!explicit ? set.instances.find((i) => i.id === set.default.instance)?.name : undefined}
      control={
        <SettingsSelect
          label={`${title}: AI provider`}
          value={explicit ? cur.instance : USE_DEFAULT}
          onValueChange={(v) => (v === USE_DEFAULT ? onChange(undefined) : pick(v))}
          options={[...(isDefault ? [] : [{ value: USE_DEFAULT, label: "Default" }]), ...providers]}
        />
      }
    >
      {withModel && explicit && inst && (
        <>
          <Row
            className={under}
            title="Model"
            control={
              cur.model && options.length ? (
                <SettingsSelect label={`${title}: model`} value={cur.model} onValueChange={(m) => onChange({ ...cur, model: m })} options={options.map((m) => ({ value: m, label: modelName(m) }))} />
              ) : (
                <span className="text-sm text-muted-foreground">Tool default</span>
              )
            }
          />
          <Row
            className={under}
            title="Thinking"
            control={
              <SettingsSelect
                label={`${title}: thinking level`}
                value={cur.effort}
                onValueChange={(e) => onChange({ ...cur, effort: e as Selection["effort"] })}
                options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
              />
            }
          />
        </>
      )}
    </Row>
  );
}
