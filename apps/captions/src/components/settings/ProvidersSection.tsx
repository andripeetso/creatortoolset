import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import {
  DRIVERS,
  JOBS,
  TOOL_NAMES,
  type Driver,
  type ProviderCheck,
  type ProviderInstance,
  type ProviderSettings,
  type ProvidersView,
  type Scope,
  type Selection,
  runsOn,
} from "@contracts/providers";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { useWorkTalk } from "@/lib/setup";
import {
  aiAnswerer,
  checkProvider,
  deviceOf,
  getProviders,
  modelName,
  modelsOf,
  saveOwn,
  saveWorkspace,
  selectionLabel,
  thisMacDevice,
} from "@/lib/providers";
import { cn } from "@/lib/utils";
import { AddProviderDialog } from "./AddProviderDialog";
import { AiSetup } from "./AiSetup";
import { OwnAiMcpSection } from "./OwnAiMcpSection";
import { Card, Dot, EffortSelect, Group, Loading, ModelSelect, Notice } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

type Device = ProvidersView["devices"][number];

/**
 * Settings → Your AI: the Macs the account has (admins also the workspace's) as tabs, the AI on the selected Mac, who
 * does which job, and for admins whether the team shares it. Admins edit the workspace's set (PUT /api/providers/workspace);
 * anyone else edits their own (PUT /api/providers/own) and sees the workspace's while they have none.
 * In chat or both, it also holds the "Use Creator Toolset from your own AI" section (OwnAiMcpSection).
 */
export function ProvidersSection({ sub }: { sub?: string }) {
  const { talk } = useWorkTalk();
  const me = useAuth((s) => s.me);
  const isAdmin = me?.role === "admin";
  const [view, setView] = useState<ProvidersView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(sub ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    getProviders().then(setView).catch((e) => setLoadError(msg(e)));
  }, []);
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
  const device: Device | null = devices.find((d) => d.id === selectedId) ?? devices[0] ?? null;
  // A member does not see the workspace's Mac in `devices`; its providers still say where they run.
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? (id || "no Mac picked");
  const reportOf = (inst: ProviderInstance) => devices.find((d) => d.id === deviceOf(inst))?.report ?? null;
  const online = (inst: ProviderInstance) => devices.find((d) => d.id === deviceOf(inst))?.online ?? false;

  // What this page edits: the workspace's set for admins, this account's own for anyone else.
  const editing: ProviderSettings | null = isAdmin ? (view.workspace?.settings ?? null) : view.own;
  const readOnly = !isAdmin && !view.own; // showing the workspace's, which answers this account now
  const scope: Scope = isAdmin || readOnly ? "workspace" : me.username;
  const shown: ProviderSettings | null = editing ?? (readOnly ? (view.workspace?.settings ?? null) : null);
  const listed = readOnly
    ? (shown?.instances ?? [])
    : (editing?.instances ?? []).filter((i) => device !== null && deviceOf(i) === device.id);

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

  const driverLabel = (d: Driver) => DRIVERS.find((x) => x.id === d)?.label ?? d;

  const renderInstance = (inst: ProviderInstance) => {
    const info = DRIVERS.find((x) => x.id === inst.driver);
    const report = reportOf(inst);
    const found = report?.drivers.find((d) => d.driver === inst.driver);
    const check = view.checks[`${scope}:${inst.id}`];
    const key = `${scope}:${inst.id}`;
    const used = jobsUsing(inst.id);
    const isOnline = online(inst);
    const toolName = TOOL_NAMES[inst.driver] ?? driverLabel(inst.driver);
    return (
      <div key={inst.id} className="flex items-start gap-3 px-3 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-[11px] font-semibold text-violet-600 dark:text-violet-300">
          {(info?.label ?? inst.driver).slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-foreground">{inst.name}</span>
            <span className="text-xs text-muted-foreground" title={inst.home || undefined}>
              {toolName} · {inst.home ? "own folder" : "default folder"}
              {found?.installed && found.version ? ` · v${found.version}` : ""}
            </span>
            {info && !runsOn(inst.driver) && <span className="text-[11px] text-muted-foreground">The Mac app doesn't run it</span>}
            {report && runsOn(inst.driver) && !found?.installed && <span className="text-[11px] text-amber-600 dark:text-amber-400">Not installed on this Mac</span>}
            {!inst.enabled && <span className="text-[11px] text-muted-foreground">Off</span>}
            {readOnly && <span className="text-[11px] text-muted-foreground">on {deviceName(deviceOf(inst))}</span>}
          </div>
          <div className="mt-1 text-[11px]">
            {checking === key ? (
              <span className="text-muted-foreground">Checking… up to a minute</span>
            ) : !check ? (
              isOnline && <span className="text-muted-foreground">Not checked: press Check</span>
            ) : check.ok ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                Ready{check.model ? ` · ${modelName(check.model)}` : ""} · {(check.ms / 1000).toFixed(1)} s · checked {fmtAgo(check.at)}
              </span>
            ) : (
              <span className="text-red-600 dark:text-red-400">{check.error || "The check failed"}</span>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <Switch
              checked={inst.enabled}
              aria-label={`Turn ${inst.name} ${inst.enabled ? "off" : "on"}`}
              onCheckedChange={(on) =>
                void save({ ...editing!, instances: editing!.instances.map((i) => (i.id === inst.id ? { ...i, enabled: on } : i)) })
              }
            />
            {!isOnline && <span className="text-[11px] text-muted-foreground">Mac offline</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runCheck(inst, scope)}
              disabled={!isOnline || checking !== null}
              title={isOnline ? "Send one short question to this AI" : "The Mac is offline"}
            >
              Check
            </Button>
            <ConfirmButton
              label="Remove"
              confirmLabel="Click again"
              disabled={used.length > 0}
              title={used.length ? `Used by ${used.join(", ")}. Pick another there first.` : "Remove this AI"}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300"
              armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
              onConfirm={() => void save({ ...editing!, instances: editing!.instances.filter((i) => i.id !== inst.id) })}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Your AI runs on a Mac, through the coding tools signed in there. Each one belongs to one Mac.
      </p>
      <p className="mt-2 text-sm">{aiAnswerer(view, thisMacDevice())}</p>
      {saving && <p className="mt-2 text-xs text-muted-foreground">Saving…</p>}
      {error && <Notice tone="error">{error}</Notice>}

      {!readOnly && (
        <AiSetup
          devices={devices}
          device={device}
          providers={listed}
          checks={Object.fromEntries(listed.map((i) => [i.id, view.checks[`${scope}:${i.id}`]]))}
          onAdd={() => setAdding(true)}
          onCheck={(inst) => void runCheck(inst, scope)}
        />
      )}

      {(talk === "chat" || talk === "both") && <OwnAiMcpSection />}

      {!isAdmin && (
        <div className="mt-8 space-y-2">
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

      {/* no Mac yet: the setup steps above say what to do, so the empty Mac and Your AI groups would only repeat it */}
      {(readOnly || devices.length > 0) && <Group
        title="Mac"
        hint={readOnly ? "Where your own AI runs. The dot shows whether it is online." : "The dot shows whether it is online. Your AI on an offline Mac can't answer."}
      >
        {devices.length === 0 ? (
          <Notice>No Mac connected yet.</Notice>
        ) : (
          <>
            <div role="tablist" aria-label="Macs" className="flex flex-wrap gap-1.5">
              {devices.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="tab"
                  aria-selected={device?.id === d.id}
                  onClick={() => setSelectedId(d.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                    device?.id === d.id ? "border-violet-500/60 bg-violet-500/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Dot on={d.online} />
                  {d.name}
                  {d.owner === "workspace" && <span className="text-[10px] uppercase tracking-wider text-muted-foreground">workspace</span>}
                </button>
              ))}
            </div>
            {device && !device.online && <p className="mt-2 text-[11px] text-muted-foreground">Offline. Its AI can't answer until it is back.</p>}
          </>
        )}
      </Group>}

      {(readOnly || devices.length > 0) && <Group
        title="Your AI"
        hint={
          readOnly
            ? "The workspace's AI, on whichever Mac runs it."
            : "One coding tool signed in as one account on this Mac. Off keeps it out of every job."
        }
      >
        {listed.length === 0 ? (
          <Notice>{readOnly ? "The workspace has no AI yet." : device ? "No AI on this Mac yet." : "Connect a Mac to add your AI."}</Notice>
        ) : (
          <Card>{listed.map(renderInstance)}</Card>
        )}
        <div>
          <Button variant="outline" size="sm" disabled={!device} onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> {readOnly && listed.length > 0 ? `Add my own on ${device ? device.name : "a Mac"}` : "Add one"}
          </Button>
        </div>
      </Group>}

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
              onChange={(v) => v && void save({ ...editing!, default: v })}
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
                  const jobs = { ...shown.jobs };
                  if (v) jobs[j.id] = v;
                  else delete jobs[j.id];
                  void save({ ...editing!, jobs });
                }}
              />
            ))}
          </Card>
        </Group>
      )}

      {isAdmin && editing && (
        <p className="text-xs text-muted-foreground">
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
