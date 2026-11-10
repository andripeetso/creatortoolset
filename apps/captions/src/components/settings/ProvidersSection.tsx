import { groupComputers } from "./computers-group";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useAuth } from "@/lib/auth";
import { autoTestDue, checkProvider, deviceOf, effortLabel, getProviders, modelName, modelsOf, saveOwn, saveWorkspace, thisMacDevice } from "@/lib/providers";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { msg } from "./helpers";
import { AddProviderDialog } from "./AddProviderDialog";
import { ProviderDetail } from "./ProviderDetail";
import { DriverMark, ProviderInstanceCard, providerStatus, withInstance, type ProviderStatus } from "./ProviderInstanceCard";
import { Advanced, Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, Section, SettingsSelect, saveFailed, StatusDot } from "./ui";
import type { SearchRowId } from "./search";

/** The tools the Mac app can open a sign-in for in Terminal (the Mac's signInCommands). */
const SIGN_IN_DRIVERS: string[] = ["claude", "codex", "grok"];
/** The "Use the Default" choice of a job (a select's option needs a value; "" is not allowed). */
const USE_DEFAULT = "use-default";

/**
 * Settings → Providers. The computers that run AI are tabs on top; the AIs on the chosen computer are the list, with the
 * tools it has installed and not yet added below them (each with Add). The AI's settings open beside the list from `lg`,
 * and as their own page (`sub` = the AI's id) below it. "Who does what" sets the Default and the tool-by-tool picks.
 * Members see the team's AI read-only, with Add my own. One refresh loop for the page, while a computer has no tool yet
 * or a sign-in is open.
 */
export function ProvidersSection({ sub }: { sub?: string }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me);
  const isAdmin = me?.role === "admin";
  const [view, setView] = useState<ProvidersView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ driver?: Driver } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const savingRef = useRef(false);
  // the report each AI was last tested for (the page tests an AI once per report)
  const tried = useRef(new Map<string, number>());

  const load = useCallback(
    () =>
      getProviders()
        .then((v) => {
          if (!savingRef.current) setView(v);
        })
        .catch((e) => setLoadError(msg(e))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const waiting = !!view && !view.devices.some((d) => d.online && d.report?.drivers.some((x) => x.installed));
  const every = signingIn ? 3000 : waiting ? 5000 : 0;
  useEffect(() => {
    if (!every) return;
    const t = window.setInterval(() => void load(), every);
    return () => window.clearInterval(t);
  }, [every, load]);
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
  // computer that has the tool. Each AI is tried once per report, so a failure stays until the next report or Test now.
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
  }, []);
  useEffect(() => {
    if (!view || !me || checking) return;
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
  }, [view, checking, isAdmin, me, testOne]);

  if (loadError)
    return (
      <Section title="Providers">
        <Card>
          <ErrorRow title="Could not load your AIs" detail={loadError} retry={() => { setLoadError(null); void load(); }} />
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
  const groups = groupComputers(devices, me.username);
  const tabGroup = groups.find((g) => g.records.some((r) => r.id === tab)) ?? groups[0] ?? null;
  const tabDevice = tabGroup?.primary ?? null;
  const listed = readOnly ? (shown?.instances ?? []) : (editing?.instances ?? []).filter((i) => !!tabGroup && tabGroup.records.some((r) => r.id === deviceOf(i)));
  const onDevice = (i: ProviderInstance) => devices.some((d) => d.id === deviceOf(i));
  const orphans = readOnly || !editing ? [] : editing.instances.filter((i) => !onDevice(i));
  const detailInst = readOnly || !editing ? undefined : sub ? editing.instances.find((i) => i.id === sub) : listed[0];
  const installedHere = !readOnly && tabDevice?.report ? tabDevice.report.drivers.filter((d) => d.installed && runsOn(d.driver) && !listed.some((i) => i.driver === d.driver)) : [];

  const reportOf = (i: ProviderInstance) => devices.find((d) => d.id === deviceOf(i))?.report ?? null;
  const statusOf = (i: ProviderInstance): ProviderStatus => {
    if (!readOnly && !onDevice(i)) return { tone: "attention", text: "No computer" };
    if (checking === `${scope}:${i.id}`) return { tone: "neutral", text: "Checking…" };
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
    const prev = view;
    setView((v) => (v && !toOwn ? (v.workspace ? { ...v, workspace: { ...v.workspace, settings: next } } : v) : v && { ...v, own: next }));
    savingRef.current = true;
    try {
      if (!toOwn) {
        const saved = await saveWorkspace(next);
        setView((v) => (v && v.workspace ? { ...v, workspace: { ...v.workspace, settings: saved } } : v));
      } else {
        setView(await saveOwn(next));
      }
    } catch (e) {
      setView(prev);
      throw e;
    } finally {
      savingRef.current = false;
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

  // The Mac app's bridge (TitleBar.swift, handler "signIn") opens the CLI's sign-in in Terminal, then the page re-reads.
  const signIn = (inst: ProviderInstance) => {
    (window as unknown as { webkit?: { messageHandlers?: { signIn?: { postMessage: (m: unknown) => void } } } }).webkit?.messageHandlers?.signIn?.postMessage({
      driver: inst.driver,
      home: inst.home ?? "",
    });
    setSigningIn(inst.driver);
  };
  const canSignIn = (inst: ProviderInstance) => !!thisMacDevice() && deviceOf(inst) === thisMacDevice() && SIGN_IN_DRIVERS.includes(inst.driver);

  const addAi = async (inst: ProviderInstance) => {
    if (!tabDevice) throw new Error("Connect a computer first.");
    await saveSet(addInstanceTo(editing, { ...inst, device: tabDevice.id }));
  };

  const openAdd = (driver?: Driver) => {
    if (!tabDevice) navigate("/settings/devices?add=1");
    else setAdding({ driver });
  };

  // ---- empty: no computer yet ----
  if (!readOnly && devices.length === 0) {
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

  const detailOpen = (inst: ProviderInstance) => `/settings/providers/${encodeURIComponent(inst.id)}`;
  const nameOf = (id: string) => DRIVERS.find((d) => d.id === id)?.label ?? id;

  return (
    <>
      {!readOnly && devices.length > 0 && (
        <Tabs value={tabDevice?.id ?? ""} onValueChange={(v) => { setTab(v); if (sub) navigate("/settings/providers"); }} className="mb-8">
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {groups.map(({ primary: d }) => (
              <TabsTrigger key={d.id} value={d.id} className="gap-1.5">
                {!d.online && <StatusDot tone="attention" />}
                <span className="max-w-40 truncate">{d.name}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <div className="grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className={cn("min-w-0 space-y-8", sub && "hidden lg:block")}>
          <Section
            id="add-provider"
            title="Providers"
            action={
              readOnly ? (
                <Button size="xs" variant="ghost" onClick={() => openAdd()}>
                  <Plus /> Add my own
                </Button>
              ) : (
                <Button size="xs" variant="ghost" onClick={() => openAdd()}>
                  <Plus /> Add provider
                </Button>
              )
            }
          >
            <Card>
              {listed.length === 0 && installedHere.length === 0 && (
                <EmptyRow
                  title={readOnly ? "No AI answers your jobs yet" : "No AI on this computer yet"}
                  description={readOnly ? "Add your own AI on a computer you connect." : "Add a tool the computer has, or add one from the list below."}
                />
              )}
              {listed.map((inst) => (
                <ProviderInstanceCard
                  key={inst.id}
                  inst={inst}
                  status={statusOf(inst)}
                  version={reportOf(inst)?.drivers.find((d) => d.driver === inst.driver)?.version}
                  selected={!readOnly && detailInst?.id === inst.id}
                  href={readOnly ? undefined : detailOpen(inst)}
                  action={!readOnly && statusOf(inst).action === "sign-in" && canSignIn(inst) ? (
                    <Button size="xs" variant="outline" onClick={() => signIn(inst)}>
                      Sign in
                    </Button>
                  ) : !readOnly && statusOf(inst).action === "install" ? (
                    <Button size="xs" variant="outline" asChild>
                      <Link to={detailOpen(inst)}>Install</Link>
                    </Button>
                  ) : undefined}
                  onToggle={readOnly ? undefined : (on) => patch(inst, { enabled: on })}
                />
              ))}
              {installedHere.map((d) => (
                <ListRow
                  key={`installed-${d.driver}`}
                  icon={<DriverMark driver={d.driver} />}
                  title={
                    <>
                      {nameOf(d.driver)}
                      {d.version && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">v{d.version}</span>}
                    </>
                  }
                  actions={
                    <Button size="xs" variant="outline" onClick={() => openAdd(d.driver)} aria-label={`Add ${nameOf(d.driver)}`}>
                      Add
                    </Button>
                  }
                />
              ))}
            </Card>
          </Section>

          {orphans.length > 0 && editing && (
            <Section title="Not on a computer">
              <Card>
                {orphans.map((inst) => (
                  <ProviderInstanceCard key={inst.id} inst={inst} status={statusOf(inst)} selected={detailInst?.id === inst.id} href={detailOpen(inst)} />
                ))}
              </Card>
            </Section>
          )}

        </div>

        <div className={cn("min-w-0", !sub && "hidden lg:block")}>
          {detailInst && editing && tabDevice ? (
            <ProviderDetail
              inst={detailInst}
              status={statusOf(detailInst)}
              check={view.checks[`${scope}:${detailInst.id}`]}
              checking={checking === `${scope}:${detailInst.id}`}
              canTest={(devices.find((d) => d.id === deviceOf(detailInst))?.online ?? true) && checking === null}
              used={usedBy(detailInst.id)}
              models={modelsOf(view, detailInst)}
              computers={!onDevice(detailInst) ? devices.map((d) => ({ id: d.id, name: d.name })) : undefined}
              computerNote={!onDevice(detailInst) ? (deviceOf(detailInst) ? "Its computer was removed: pick another." : "Pick the computer that runs it.") : undefined}
              backTo="/settings/providers"
              onChange={(p) => patch(detailInst, p)}
              onTest={() => void runCheck(detailInst)}
              onSignIn={statusOf(detailInst).action === "sign-in" && canSignIn(detailInst) ? () => signIn(detailInst) : undefined}
              onMove={onDevice(detailInst) ? undefined : (id) => patch(detailInst, { device: id })}
              onRemove={() => remove(detailInst)}
            />
          ) : sub ? (
            <Card>
              <EmptyRow title="This AI is no longer here" />
              <div className="px-3 pb-3 sm:px-4">
                <Button asChild size="sm" variant="outline">
                  <Link to="/settings/providers">Back to the list</Link>
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      </div>

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

          {isAdmin && editing && (
            <Card>
              <Row title="Who else can use it" control={<Button asChild size="xs" variant="ghost"><Link to="/settings/admin/access">Admin → Access</Link></Button>} />
            </Card>
          )}
        </div>
      )}

      {adding && tabDevice && (
        <AddProviderDialog
          deviceName={tabDevice.name}
          report={tabDevice.report ?? null}
          instances={editing?.instances ?? []}
          initialDriver={adding.driver}
          onClose={() => setAdding(null)}
          onAdd={addAi}
        />
      )}
    </>
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

  const explicit = isDefault || !!sel;
  const defaultName = set.instances.find((i) => i.id === set.default.instance)?.name ?? "the Default";
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
      {explicit && inst && (
        <div className="flex flex-wrap gap-2">
          {models.length > 0 ? (
            <SettingsSelect
              label={`${title}: model`}
              value={models.includes(cur.model) ? cur.model : models[0]!}
              onValueChange={(m) => onChange({ ...cur, model: m })}
              options={models.map((m) => ({ value: m, label: modelName(m) }))}
            />
          ) : (
            <span className="self-center text-xs text-muted-foreground">Uses the tool's own default</span>
          )}
          <SettingsSelect
            label={`${title}: thinking level`}
            value={cur.effort}
            onValueChange={(e) => onChange({ ...cur, effort: e as Selection["effort"] })}
            options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
          />
        </div>
      )}
    </Row>
  );
}
