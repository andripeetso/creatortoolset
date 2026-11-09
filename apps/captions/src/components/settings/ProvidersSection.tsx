import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  JOBS,
  type Driver,
  type ProviderCheck,
  type ProviderInstance,
  type ProviderSettings,
  type ProvidersView,
  type Scope,
  type Selection,
  runsOn,
} from "@contracts/providers";
import { useAuth } from "@/lib/auth";
import { useWorkTalk } from "@/lib/setup";
import {
  checkProvider,
  deviceOf,
  getProviders,
  modelsOf,
  saveOwn,
  saveWorkspace,
  selectionLabel,
  thisMacDevice,
} from "@/lib/providers";
import { AddProviderDialog } from "./AddProviderDialog";
import { OwnAiMcpSection } from "./OwnAiMcpSection";
import { ProviderDetail } from "./ProviderDetail";
import { ProviderInstanceCard, hasCustomEndpoint, providerStatus, withInstance, type ProviderStatus } from "./ProviderInstanceCard";
import { ScopeSentence } from "./ScopeSentence";
import { Card, EffortSelect, Group, Loading, ModelSelect, Notice } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

/** The CLIs the Mac app can open a sign-in for (signInCommands in apps/mac Relay.swift). */
const SIGN_IN_DRIVERS: string[] = ["claude", "codex", "grok"];

/**
 * Settings → Providers: "Applying settings for All projects on <Mac>", the AI on that Mac as rows (name, version, status
 * line, on/off switch), the selected AI's detail below, then who does which job. Admins edit the workspace's set
 * (PUT /api/providers/workspace); anyone else edits their own (PUT /api/providers/own) and sees the workspace's while they
 * have none. In chat or both, it also holds the "Use Creator Toolset from your own AI" section (OwnAiMcpSection).
 * `sub` is the Mac picked on the page (its device id).
 */
export function ProvidersSection({ sub }: { sub?: string }) {
  const { talk } = useWorkTalk();
  const me = useAuth((s) => s.me);
  const isAdmin = me?.role === "admin";
  const [view, setView] = useState<ProvidersView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deviceChoice, setDeviceChoice] = useState<string | null>(sub ?? null);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The driver whose sign-in is open in Terminal on this Mac: the page re-reads the Mac's report until it says signed in.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  // when the Macs' reports were last read (the page's "Checked …")
  const [readAt, setReadAt] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    getProviders().then((v) => {
      setView(v);
      setReadAt(Date.now());
    }).catch((e) => setLoadError(msg(e)));
  }, []);
  const refresh = () => {
    setRefreshing(true);
    getProviders()
      .then((v) => {
        setView((prev) => (prev ? { ...prev, devices: v.devices } : v));
        setReadAt(Date.now());
      })
      .catch((e) => setError(msg(e)))
      .finally(() => setRefreshing(false));
  };
  useEffect(() => {
    if (!signingIn) return;
    const t = window.setInterval(() => {
      getProviders()
        .then((v) => {
          setView((prev) => (prev ? { ...prev, devices: v.devices } : v));
          const mac = thisMacDevice();
          const found = v.devices.find((d) => d.id === mac)?.report?.drivers.find((d) => d.driver === signingIn);
          if (found?.signedIn) setSigningIn(null);
        })
        .catch(() => {});
    }, 3000);
    const stop = window.setTimeout(() => setSigningIn(null), 180000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [signingIn]);
  // until a Mac reports a coding tool, look again every 5 s: installing one shows up without a reload
  const waiting = !!view && !view.devices.some((d) => d.online && d.report?.drivers.some((x) => x.installed));
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => {
      getProviders().then((v) => setView((prev) => (prev ? { ...prev, devices: v.devices } : v))).catch(() => {});
    }, 5000);
    return () => window.clearInterval(t);
  }, [waiting]);

  if (loadError) return <Notice tone="error">Could not load your AI: {loadError}</Notice>;
  if (!view || !me) return <Loading />;

  const devices = view.devices;
  const device = devices.find((d) => d.id === deviceChoice) ?? devices[0] ?? null;
  // A member does not see the workspace's Mac in `devices`; its providers still say where they run.
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? (id || "no Mac picked");
  const reportOf = (inst: ProviderInstance) => devices.find((d) => d.id === deviceOf(inst))?.report ?? null;
  // Unknown Macs (a member's view of the workspace's) count as reachable: only a Mac listed as offline is.
  const reachable = (inst: ProviderInstance) => devices.find((d) => d.id === deviceOf(inst))?.online ?? true;
  const online = (inst: ProviderInstance) => devices.find((d) => d.id === deviceOf(inst))?.online ?? false;

  // What this page edits: the workspace's set for admins, this account's own for anyone else.
  const editing: ProviderSettings | null = isAdmin ? (view.workspace?.settings ?? null) : view.own;
  const readOnly = !isAdmin && !view.own; // showing the workspace's, which answers this account now
  const scope: Scope = isAdmin || readOnly ? "workspace" : me.username;
  const shown: ProviderSettings | null = editing ?? (readOnly ? (view.workspace?.settings ?? null) : null);
  const listed = readOnly
    ? (shown?.instances ?? [])
    : (editing?.instances ?? []).filter((i) => device !== null && (deviceOf(i) === device.id || !deviceOf(i)));
  // the provider whose detail pane is open (editors only; members see the rows)
  // the first provider is shown until one is picked, so the settings pane is never empty
  const detail = readOnly || !editing ? undefined : (listed.find((i) => i.id === instanceId) ?? listed[0]);

  // Saves the whole set. Shows the change at once, undoes it on error.
  const save = async (next: ProviderSettings) => {
    const prev = view;
    setView((v) => (v && isAdmin ? (v.workspace ? { ...v, workspace: { ...v.workspace, settings: next } } : v) : v && { ...v, own: next }));
    setSaving(true);
    setError(null);
    try {
      if (isAdmin) {
        const saved = await saveWorkspace(next);
        setView((v) => (v && v.workspace ? { ...v, workspace: { ...v.workspace, settings: saved } } : v));
      } else {
        setView(await saveOwn(next));
      }
    } catch (e) {
      setView(prev);
      setError(msg(e));
    } finally {
      setSaving(false);
    }
  };

  // Changes one provider's fields (its switch, its detail pane) and saves the set.
  const patch = (inst: ProviderInstance, p: Partial<ProviderInstance>) => {
    if (editing) void save(withInstance(editing, inst.id, p));
  };

  const dropOwn = async () => {
    setSaving(true);
    setError(null);
    try {
      setView(await saveOwn(null));
    } catch (e) {
      setError(msg(e));
    } finally {
      setSaving(false);
    }
  };

  // The first provider an account adds starts its own set, with that provider as the default.
  const addInstance = (inst: ProviderInstance) => {
    if (!device) return;
    const withDevice: ProviderInstance = { ...inst, device: device.id };
    const base: ProviderSettings = editing ?? {
      instances: [],
      default: { instance: "", model: "", effort: "xhigh" },
      jobs: {},
    };
    const first = modelsOf(view, withDevice)[0] ?? "";
    void save({
      ...base,
      instances: [...base.instances, withDevice],
      default: base.instances.length ? base.default : { instance: withDevice.id, model: first, effort: "xhigh" },
    });
  };

  const runCheck = async (inst: ProviderInstance, s: Scope) => {
    const key = `${s}:${inst.id}`;
    setChecking(key);
    let result: ProviderCheck;
    try {
      result = await checkProvider(s, inst.id);
    } catch (e) {
      result = { ok: false, ms: 0, error: msg(e), at: Date.now() };
    }
    setView((v) => (v ? { ...v, checks: { ...v.checks, [key]: result } } : v));
    setChecking(null);
  };

  const jobsUsing = (id: string) =>
    shown
      ? [shown.default.instance === id ? "the default" : null, ...JOBS.filter((j) => shown.jobs[j.id]?.instance === id).map((j) => j.label)].filter(
          (x): x is string => !!x,
        )
      : [];

  // The Mac's report of this provider's CLI (its version, signed-in state) and the status line built from it.
  const foundOf = (inst: ProviderInstance) => reportOf(inst)?.drivers.find((d) => d.driver === inst.driver);
  const statusOf = (inst: ProviderInstance): ProviderStatus =>
    !deviceOf(inst)
      ? { tone: "warning", text: "Not on a Mac yet" }
      : providerStatus({
      enabled: inst.enabled,
      runs: runsOn(inst.driver),
      online: reachable(inst),
      report: !!reportOf(inst),
      found: foundOf(inst),
      check: view.checks[`${scope}:${inst.id}`],
    });

  // Sign in shows only in the Mac app, for a provider on this Mac whose CLI says it is not signed in (or whose check failed).
  const canSignIn = (inst: ProviderInstance) => {
    const mac = thisMacDevice();
    const failed = !!view.checks[`${scope}:${inst.id}`] && !view.checks[`${scope}:${inst.id}`].ok;
    return !!mac && deviceOf(inst) === mac && SIGN_IN_DRIVERS.includes(inst.driver) && (statusOf(inst).text === "Not signed in" || failed);
  };
  // The Mac app's bridge (TitleBar.swift, handler "signIn"): it opens the CLI's sign-in in Terminal, then re-reports.
  const signIn = (inst: ProviderInstance) => {
    (window as unknown as { webkit?: { messageHandlers?: { signIn?: { postMessage: (m: unknown) => void } } } }).webkit?.messageHandlers?.signIn?.postMessage({
      driver: inst.driver,
      home: inst.home ?? "",
    });
    setSigningIn(inst.driver);
  };

  return (
    <>
      <ScopeSentence devices={devices} device={device} readOnly={readOnly} onPick={setDeviceChoice} />
      {saving && <p className="mt-2 text-xs text-muted-foreground">Saving…</p>}
      {error && <Notice tone="error">{error}</Notice>}

      {!isAdmin && (
        <div className="mt-6 space-y-2">
          {view.using === "own" && (
            <Notice>
              Your own AI answers your jobs.{" "}
              {view.workspace && (
                <button type="button" onClick={() => void dropOwn()} className="underline underline-offset-2 hover:text-foreground">
                  Use the workspace's AI instead
                </button>
              )}
            </Notice>
          )}
          {view.using === "workspace" && <Notice>You use the workspace's AI. Add your own on a Mac you connect; it answers instead.</Notice>}
          {view.using === "none" && <Notice tone="warn">No AI answers your jobs yet. Connect a Mac, then add one to it.</Notice>}
        </div>
      )}

      {(readOnly || devices.length > 0) && (
        // one column: the list of providers, "Add provider" last in the same card, then the selected provider's settings
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">Providers</h2>
              <button
                type="button"
                aria-label="Add provider"
                disabled={!device}
                onClick={() => setAdding(true)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              {refreshing ? "Checking…" : readAt > Date.now() - 60_000 ? "Checked just now" : `Checked ${fmtAgo(readAt)}`}
            </button>
          </div>
          <Card className="mt-3">
            {listed.length === 0 ? (
              <div className="px-4 py-3">
                <Notice>{readOnly ? "The workspace has no AI yet." : device ? "No AI on this Mac yet." : "Connect a Mac to add your AI."}</Notice>
              </div>
            ) : (
              listed.map((inst) => {
                const found = foundOf(inst);
                return (
                  <ProviderInstanceCard
                    key={inst.id}
                    inst={inst}
                    status={statusOf(inst)}
                    version={found?.installed ? found.version : undefined}
                    customEndpoint={hasCustomEndpoint(reportOf(inst), inst)}
                    selected={detail?.id === inst.id}
                    readOnly={readOnly}
                    where={readOnly ? deviceName(deviceOf(inst)) : undefined}
                    onSelect={() => setInstanceId(inst.id)}
                    onToggle={(on) => patch(inst, { enabled: on })}
                  />
                );
              })
            )}
            <button
              type="button"
              disabled={!device}
              onClick={() => setAdding(true)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              {readOnly && listed.length > 0 ? `Add my own on ${device ? device.name : "a Mac"}` : "Add provider"}
            </button>
            {detail && device && (
              <ProviderDetail
                inst={detail}
                status={statusOf(detail)}
                check={view.checks[`${scope}:${detail.id}`]}
                checking={checking === `${scope}:${detail.id}`}
                canCheck={online(detail) && checking === null}
                used={jobsUsing(detail.id)}
                runHere={!deviceOf(detail) ? device.name : undefined}
                onChange={(p) => patch(detail, p)}
                onCheck={() => void runCheck(detail, scope)}
                onSignIn={canSignIn(detail) ? () => signIn(detail) : undefined}
                onRunHere={!deviceOf(detail) ? () => patch(detail, { device: device.id }) : undefined}
                onRemove={() => {
                  setInstanceId(null);
                  if (editing) void save({ ...editing, instances: editing.instances.filter((i) => i.id !== detail.id) });
                }}
              />
            )}
          </Card>
        </div>
      )}

      {(talk === "chat" || talk === "both") && <OwnAiMcpSection />}

      {shown && (
        <Group
          title="Who does which job"
          hint={readOnly ? "Set by the workspace. Add your own AI to choose." : "A job without its own pick uses the default."}
        >
          <Card className="px-3">
            <JobRow
              label="Everything else"
              set={shown}
              listModels={(i) => modelsOf(view, i)}
              value={shown.default}
              disabled={readOnly || saving}
              onChange={(v) => v && editing && void save({ ...editing, default: v })}
            />
            {JOBS.map((j) => (
              <JobRow
                key={j.id}
                label={j.label}
                set={shown}
                listModels={(i) => modelsOf(view, i)}
                value={shown.jobs[j.id]}
                fallback={shown.default}
                disabled={readOnly || saving}
                onChange={(v) => {
                  if (!editing) return;
                  const jobs = { ...shown.jobs };
                  if (v) jobs[j.id] = v;
                  else delete jobs[j.id];
                  void save({ ...editing, jobs });
                }}
              />
            ))}
          </Card>
        </Group>
      )}

      {isAdmin && editing && (
        <p className="mt-8 text-xs text-muted-foreground">
          This is the workspace's AI. Who else may use it:{" "}
          <Link to="/settings/admin/ai" className="underline underline-offset-2 hover:text-foreground">
            Admin → AI access
          </Link>
          .
        </p>
      )}

      {adding && device && (
        <AddProviderDialog
          deviceName={device.name}
          report={device.report ?? null}
          instances={editing?.instances ?? []}
          onClose={() => setAdding(false)}
          onAdd={async (inst) => addInstance(inst)}
        />
      )}
    </>
  );
}

/** One job (or the default): its provider, model and effort. `value` undefined = "Use default" (shows the default's pick). */
function JobRow({
  label,
  set,
  listModels,
  value,
  fallback,
  disabled,
  onChange,
}: {
  label: string;
  set: ProviderSettings;
  listModels: (inst: ProviderInstance) => string[];
  value?: Selection;
  /** Set for a job row: the default it falls back to. Unset for the default row itself. */
  fallback?: Selection;
  disabled?: boolean;
  onChange: (v: Selection | undefined) => void;
}) {
  const isDefault = !fallback;
  const current = value ?? fallback ?? set.default;
  const modelsOfId = (id: string) => {
    const inst = set.instances.find((i) => i.id === id);
    return inst ? listModels(inst) : [];
  };
  const pickInstance = (id: string) => {
    const list = modelsOfId(id);
    const model = list.includes(current.model) ? current.model : (list[0] ?? current.model);
    onChange({ instance: id, model, effort: current.effort });
  };
  const known = set.instances.some((i) => i.id === current.instance);
  const instanceOptions = known ? set.instances : [...set.instances, { id: current.instance, driver: "claude" as Driver, name: current.instance || "None", enabled: false }];
  const explicit = isDefault || !!value;

  return (
    <div className="flex flex-wrap items-center gap-2 py-3">
      <div className="mr-auto min-w-[10rem] flex-1">
        <div className="text-sm text-foreground">{label}</div>
      </div>
      <select
        value={explicit ? current.instance : ""}
        disabled={disabled}
        onChange={(e) => (e.target.value ? pickInstance(e.target.value) : onChange(undefined))}
        className={selectCls}
        aria-label={`${label}: AI`}
      >
        {!isDefault && <option value="">Use default</option>}
        {instanceOptions.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
            {i.enabled ? "" : " (off)"}
          </option>
        ))}
      </select>
      {explicit ? (
        <>
          <ModelSelect value={current.model} options={modelsOfId(current.instance)} disabled={disabled} onChange={(m) => onChange({ ...current, model: m })} />
          <EffortSelect value={current.effort} disabled={disabled} onChange={(e) => onChange({ ...current, effort: e })} />
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{selectionLabel(current)}</span>
      )}
    </div>
  );
}
