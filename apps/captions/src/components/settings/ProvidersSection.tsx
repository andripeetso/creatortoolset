import { groupComputers } from "./computers-group";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Plus, RotateCcw } from "lucide-react";
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
import { Advanced, Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, Section, SettingsSelect, saveFailed, Status, StatusDot } from "./ui";
import type { SearchRowId } from "./search";

/** The tools the Mac app can start a sign-in for: in Terminal (the Mac's signInCommands), Muse Code's in the browser. */
const SIGN_IN_DRIVERS: string[] = ["claude", "codex", "grok", "musecode"];
/** The "Use the Default" choice of a job (a select's option needs a value; "" is not allowed). */
const USE_DEFAULT = "use-default";

/**
 * Settings → Providers. The computers that run AI are tabs on top. Under them is one bordered panel: on the left the
 * AIs on the chosen computer, the tools it has installed and not yet added (each with Add) and Add provider; on the
 * right the chosen AI's settings. Below `lg` the panel shows one or the other (`sub` = the AI's id is its own page).
 * "Who does what" sets the Default and the tool-by-tool picks.
 * A member sees the AI they use: their own, or the team's API budget. On an own-computer install with no Mac app paired,
 * the list is the AI apps found on this computer (the same source as Headless access).
 */
/** "2.1.321" from "2.1.321 (Claude Code)", "codex-cli 0.39.0" or "grok 1.0.4 (d846eb93d94d)": the number a person reads. */
export const shortVersion = (v: string | undefined): string | undefined => v?.match(/\d+(?:\.\d+)+/)?.[0] ?? v;

export function ProvidersSection({ sub }: { sub?: string }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me);
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
          <ErrorRow title="Could not load your AIs" detail={providers.error} retry={refreshAll} />
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
    if (!readOnly && !onDevice(i)) return { tone: "attention", text: "No computer" };
    // while a test runs the status stays what it was: the detail's title says "Checking…" and its help lines stay put
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
    shown ? [shown.default.instance === id ? "the Default" : null, ...JOBS.filter((j) => shown.jobs[j.id]?.instance === id).map((j) => j.label)].filter((x): x is string => !!x) : [];

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
    void localSignIn(inst.driver as CliId).then((r) => !r.ok && saveFailed(r.message ?? "Couldn't start the sign-in."), (e) => saveFailed(msg(e)));
  };
  const installHere = async (inst: ProviderInstance) => {
    setInstalling(inst.id);
    try {
      const r = await localInstall(inst.driver as CliId);
      if (!r.ok) saveFailed(r.message ?? "Couldn't install it. Try again.");
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setInstalling(null);
      refreshAll();
    }
  };

  const addAi = async (inst: ProviderInstance) => {
    if (!tabDevice) throw new Error("Connect a computer first.");
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

  // ---- a member: the AI they use, read-only (their own set is the only one they edit) ----
  if (readOnly) {
    const team = view.teamAi;
    return (
      <Section id="add-provider" title="Providers">
        <Card>
          {team ? (
            <TeamAiRow team={team} description="Content Workshop needs your own AI." onAdd={() => openAdd()} />
          ) : (
            <>
              <EmptyRow title="No AI answers your jobs yet" description="Add your own AI on a computer you connect." />
              <div className="px-3 pb-3 sm:px-4">
                <Button size="sm" variant="outline" onClick={() => openAdd()}>
                  <Plus /> Add my own
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
        <Section id="add-provider" title="Providers">
          <Card>
            <LocalAiRows rows={localAi.rows.filter((r) => r.kind === "cli")} device={thisMacDevice() ?? ""} onChanged={refreshAll} />
          </Card>
        </Section>
      );
    }
    if (!localAi) {
      return (
        <Section id="add-provider" title="Providers">
          <Card>
            <LoadingRow />
          </Card>
        </Section>
      );
    }
    return (
      <Section id="add-provider" title="Providers">
        <Card>
          <EmptyRow title="No computer connected" description="Your AI runs on your own computer, through the Mac app or the command-line tool." />
          <div className="px-3 pb-3 sm:px-4">
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/devices?add=1">Add computer</Link>
            </Button>
          </div>
        </Card>
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

      {/* one panel: the list on the left, the chosen AI's settings on the right (below `lg`, one or the other) */}
      <Section id="add-provider" title="Providers">
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
            <button
              type="button"
              onClick={() => openAdd()}
              className="flex h-12 w-full items-center gap-3 px-3 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
            >
              <span className="flex size-5 items-center justify-center">
                <Plus className="size-4" aria-hidden />
              </span>
              Add provider
            </button>
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
                  computerNote={!onDevice(detailInst) ? (deviceOf(detailInst) ? "Its computer was removed: pick another." : "Pick the computer that runs it.") : undefined}
                  backTo="/settings/providers"
                  onChange={(p) => patch(detailInst, p)}
                  onTest={() => void runCheck(detailInst)}
                  onSignIn={statusOf(detailInst).action === "sign-in" && localHere && isLocalCli(detailInst.driver) ? () => signInHere(detailInst) : statusOf(detailInst).action === "sign-in" && canSignIn(detailInst) ? () => signIn(detailInst) : undefined}
                  onMove={onDevice(detailInst) ? undefined : (id) => patch(detailInst, { device: id })}
                  onRemove={() => remove(detailInst)}
                />
              ) : (
                <>
                  <EmptyRow title="This AI is no longer here" />
                  <div className="px-3 pb-3 sm:px-4">
                    <Button asChild size="sm" variant="outline">
                      <Link to="/settings/providers">Back to the list</Link>
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      {view.teamAi && (
        <div className={cn("mt-8", sub && "hidden lg:block")}>
          <Section title="Team's AI">
            <Card>
              <TeamAiRow team={view.teamAi} description="Used when none of your AIs can run. Content Workshop needs your own AI." onAdd={() => openAdd()} />
            </Card>
          </Section>
        </div>
      )}

      {shown && (
        <div className={cn("mt-8 space-y-8", sub && "hidden lg:block")}>
          <Section title="Who does what">
            <Card>
              <PickRow
                id="default-ai"
                title="Default"
                sel={shown.default}
                set={shown}
                listModels={(i) => modelsOf(view, i)}
                readOnly={readOnly}
                withModel={false}
                onChange={(v) => v && editing && void save({ ...editing, default: v })}
              />
              <Advanced summary="A different AI for one tool">
                {JOBS.map((j, n) => (
                  <PickRow
                    key={j.id}
                    id={n === 0 ? "tool-ai" : undefined}
                    title={j.label}
                    sel={shown.jobs[j.id]}
                    fallback={shown.default}
                    set={shown}
                    listModels={(i) => modelsOf(view, i)}
                    readOnly={readOnly}
                    onChange={(v) => {
                      if (!editing) return;
                      const jobs = { ...editing.jobs };
                      if (v) jobs[j.id] = v;
                      else delete jobs[j.id];
                      void save({ ...editing, jobs });
                    }}
                  />
                ))}
              </Advanced>
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
 * The team's AI for a member on the team's API budget: what they may spend this month and what they spent. Only their
 * own numbers. Its one action is Add my own (a computer of their own), as the secondary action.
 */
function TeamAiRow({ team, description, onAdd }: { team: NonNullable<ProvidersView["teamAi"]>; description: string; onAdd: () => void }) {
  const status = !team.ready ? (
    <Status tone="attention">The team's AI isn't set up on this server. Ask the owner.</Status>
  ) : team.left <= 0 ? (
    <Status tone="attention">Used up for this month. Ask the owner for more.</Status>
  ) : (
    <span className="text-muted-foreground">{money(team.spentUsd)} spent this month</span>
  );
  return (
    <Row
      title={`You use the team's AI, up to ${money(team.budgetUsd)} a month`}
      description={description}
      status={status}
      control={
        <Button size="sm" variant="outline" onClick={onAdd}>
          Add my own
        </Button>
      }
    />
  );
}

/**
 * One pick: an AI, its model and thinking level. `sel` undefined on a job = "Use the Default" (its status says which AI that
 * is). Read-only (the team's): the pick as text, no controls.
 */
function PickRow({
  id,
  title,
  sel,
  fallback,
  set,
  listModels,
  readOnly,
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
  readOnly: boolean;
  /** a per-tool pick may override the model and thinking level; the Default's are the AI's own (in its detail) */
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

  if (readOnly) {
    return <Row id={id} title={title} status={`${inst?.name ?? "No AI"}${sel || isDefault ? ` · ${modelName(cur.model) || "Tool's default"} · ${effortLabel(cur.effort)}` : ""}`} />;
  }
  if (!withModel) {
    // the Default: only the choice of which AI; the model and thinking level are on that AI's own page
    return (
      <Row
        id={id}
        title={title}
        control={
          <SettingsSelect
            label={`${title}: AI`}
            value={cur.instance}
            onValueChange={(v) => pick(v)}
            options={set.instances.map((i) => ({ value: i.id, label: `${i.name}${i.enabled ? "" : " (off)"}` }))}
          />
        }
      />
    );
  }

  const explicit = isDefault || !!sel;
  const defaultName = set.instances.find((i) => i.id === set.default.instance)?.name ?? "the Default";
  // the stored model is always offered, even when the tool's list doesn't have it (never swapped for the first one)
  const options = modelChoices(models, cur.model);
  return (
    <Row
      id={id}
      title={title}
      status={!explicit ? `Uses ${defaultName}` : undefined}
      control={
        <div className="flex items-center gap-2">
          <SettingsSelect
            label={`${title}: AI`}
            value={explicit ? cur.instance : USE_DEFAULT}
            onValueChange={(v) => (v === USE_DEFAULT ? onChange(undefined) : pick(v))}
            options={[
              ...(isDefault ? [] : [{ value: USE_DEFAULT, label: "Use the Default" }]),
              ...set.instances.map((i) => ({ value: i.id, label: `${i.name}${i.enabled ? "" : " (off)"}` })),
            ]}
          />
          {!isDefault && sel && (
            <Button size="icon-xs" variant="ghost" aria-label={`Use the Default for ${title}`} title="Use the Default" onClick={() => onChange(undefined)}>
              <RotateCcw />
            </Button>
          )}
        </div>
      }
    >
      {withModel && explicit && inst && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {cur.model && options.length ? (
            <Field label="Model">
              <SettingsSelect
                label={`${title}: model`}
                value={cur.model}
                onValueChange={(m) => onChange({ ...cur, model: m })}
                options={options.map((m) => ({ value: m, label: modelName(m) }))}
                className="sm:w-56"
              />
            </Field>
          ) : (
            <span className="self-center text-xs text-muted-foreground">Uses the tool's own default</span>
          )}
          <Field label="Thinking">
            <SettingsSelect
              label={`${title}: thinking level`}
              value={cur.effort}
              onValueChange={(e) => onChange({ ...cur, effort: e as Selection["effort"] })}
              options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
              className="sm:w-36"
            />
          </Field>
        </div>
      )}
    </Row>
  );
}

/** A select's visible label, above it: both selects of a row share one height and width. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
