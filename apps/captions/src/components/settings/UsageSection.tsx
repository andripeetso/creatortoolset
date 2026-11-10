import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DRIVERS, type LimitsIdentity, type LimitWindow, type ProviderInstance, type ProvidersView } from "@contracts/providers";
import { PLANS, type PlanId } from "@contracts/plans";
import type { SetupView } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { USAGE_PERIODS, deviceOf, getProviders, thisMacDevice, usageSince, type UsageRow } from "@/lib/providers";
import { countedWindow, identityKey, leftOf, noticeOf, resetsIn } from "@/lib/limits";
import { useSetup } from "@/lib/setup";
import { tokensLabel } from "@/lib/workshop";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "./ProviderLogos";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, Section, SettingsSelect, saveFailed } from "./ui";
import { msg } from "./helpers";
import { hasThisMac, tell, useThisMac, type ThisMacState } from "./ThisMacSection";

const RELOAD_MS = 5 * 60_000; // the Macs post their readings every five minutes
const TICK_MS = 60_000; // the countdowns
const STALE_MS = 15 * 60_000;
const LOW = 20; // a window at or under this share left is amber
const API = " (API)"; // the tally's label for calls on the app's own Anthropic key
const TOOL: Record<string, string> = { Automation: "Scheduled task" };

/**
 * Settings → Usage: the plan left on each AI login (one fetch, every five minutes), then what the app used in the period
 * picked, as one table by tool and AI.
 */
export function UsageSection() {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [now, setNow] = useState(() => Date.now());
  // the Mac app's own Plan limits switch, read live (ThisMacSection's hook; a browser reads nothing)
  const bridge = useThisMac(hasThisMac());
  const limitsOn = bridge?.limits;
  const wasOff = useRef(false);
  // the plan the person picked (setup's answer); "Your plan" reads it, and the warning before a heavy run does too
  const setup = useSetup((s) => s.view);
  useEffect(() => {
    if (!setup) void useSetup.getState().load();
  }, [setup]);

  const load = useCallback(
    () =>
      getProviders()
        .then((v) => {
          setView(v);
          setError(null);
          setNow(Date.now());
        })
        .catch((e) => setError(msg(e))),
    [],
  );

  useEffect(() => {
    void load();
    const reload = setInterval(() => void load(), RELOAD_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearInterval(reload);
      clearInterval(tick);
    };
  }, [load]);

  // turned on from the row's button: the readings it starts come in now, not in five minutes
  useEffect(() => {
    if (limitsOn === false) wasOff.current = true;
    else if (limitsOn && wasOff.current) {
      wasOff.current = false;
      void load();
    }
  }, [limitsOn, load]);

  if (!view) {
    return (
      <Section title="Plan limits">
        <Card>{error ? <ErrorRow title="Could not load usage" detail={error} retry={() => void load()} /> : <LoadingRow title="Loading usage…" />}</Card>
      </Section>
    );
  }

  return (
    <div className="space-y-8">
      <PlanLimits view={view} now={now} bridge={bridge} setup={setup} />
      <Activity view={view} days={days} onDays={setDays} />
    </div>
  );
}

/** One card per AI login with a reading, then one row for each Claude or Codex AI that has none, with the true reason. */
export function PlanLimits({ view, now, bridge, setup }: { view: ProvidersView; now: number; bridge: ThisMacState | null; setup: SetupView | null }) {
  const logins = [...view.limits].sort((a, b) => (a.driver === b.driver ? a.label.localeCompare(b.label) : a.driver === "claude" ? -1 : 1));
  const unread = missingReadings(view);
  if (logins.length === 0 && unread.length === 0) {
    return (
      <Section id="plan-limits" title="Plan limits">
        <Card>
          <EmptyRow title="No plan limits to show" description="Add Claude or Codex in Providers, and the plan left on it shows here." />
        </Card>
      </Section>
    );
  }
  return (
    <Section id="plan-limits" title="Plan limits">
      {logins.map((i) => (
        <LoginCard key={identityKey(i)} i={i} view={view} now={now} />
      ))}
      {unread.length > 0 && (
        <Card>
          {unread.map(({ inst, device }, n) => (
            <Unread key={n} inst={inst} device={device} view={view} bridge={bridge} />
          ))}
        </Card>
      )}
      {(logins.length > 0 || unread.length > 0) && <YourPlan setup={setup} />}
    </Section>
  );
}

/**
 * "Your plan", asked only when no reading tells the plan (setup's detected plan). The answer is what a heavy run reads
 * before it starts (confirmHeavy in lib/setup.ts; it asks first on Pro and Plus).
 */
function YourPlan({ setup }: { setup: SetupView | null }) {
  if (!setup || setup.detected) return null;
  const save = (v: string) => void useSetup.getState().save({ plan: v === "none" ? null : (v as PlanId) }).catch(() => saveFailed("That did not save. Try again."));
  return (
    <Card>
      <Row
        id="your-plan"
        title="Your plan"
        description="Pro and Plus: heavy runs ask first, since they can use up the 5-hour limit."
        control={
          <SettingsSelect
            label="Your plan"
            value={setup.plan ?? "none"}
            onValueChange={save}
            options={[{ value: "none", label: "Not sure" }, ...PLANS.map((p) => ({ value: p.id, label: p.label }))]}
          />
        }
      />
    </Card>
  );
}

/** The enabled Claude and Codex AIs this account sees that have no reading (a login names its instances in `instances`). */
function missingReadings(view: ProvidersView): Array<{ inst: ProviderInstance; device: string }> {
  const sets = [...(view.own?.instances ?? []), ...(view.workspace?.settings.instances ?? [])];
  return sets
    .filter((i) => i.enabled && (i.driver === "claude" || i.driver === "codex"))
    .map((inst) => ({ inst, device: deviceOf(inst) }))
    .filter(({ inst, device }) => !view.limits.some((l) => l.driver === inst.driver && l.device === device && l.instances.some((k) => k.endsWith(`:${inst.id}`))));
}

/** One AI login: its logo, name, computer and plan, then a bar per window with the share left and when it resets. */
function LoginCard({ i, view, now }: { i: LimitsIdentity; view: ProvidersView; now: number }) {
  const mac = view.devices.find((d) => d.id === i.device);
  const plan = mac?.report?.drivers.find((d) => d.driver === i.driver)?.plan;
  const driver = DRIVERS.find((d) => d.id === i.driver)?.label ?? i.driver;
  // the Mac reports each Claude folder with whether it has a custom endpoint; the folder is named ".claude" or ".claude-<label>"
  const folder = i.label === "default" ? `.${i.driver}` : `.${i.driver}-${i.label}`;
  const custom = !!mac?.report?.homes.some((h) => h.driver === i.driver && h.home.split("/").pop() === folder && h.customEndpoint);
  const notice = noticeOf(i, custom);
  return (
    <Card>
      <ListRow
        icon={<ProviderLogo driver={i.driver} className="size-4" />}
        title={i.label === "default" ? driver : `${driver} · ${i.label}`}
        subtitle={[plan, mac?.name].filter(Boolean).join(" · ") || undefined}
        status={staleLine(i, now)}
      />
      {i.state === "ok" && i.windows.map((w) => <WindowBar key={w.id} w={countedWindow(i, w, now)} now={now} />)}
      {notice && <Row title="No plan reading" description={notice} />}
    </Card>
  );
}

/**
 * An AI with no reading: the true reason for its computer, and the fix where the person can make one. On this Mac, a Mac
 * app that reports its switch (`bridge.limits`) turns it on from the row; elsewhere the row names the fix.
 */
function Unread({ inst, device, view, bridge }: { inst: ProviderInstance; device: string; view: ProvidersView; bridge: ThisMacState | null }) {
  const mac = view.devices.find((d) => d.id === device);
  const who = mac?.name ?? "another Mac";
  const here = thisMacDevice() === device;
  const reported = here && typeof bridge?.limits === "boolean" ? bridge.limits : undefined;
  // the Mac app reports its version, the worker does not; a Mac app posts no sign-in state while its switch is off
  const installed = (mac?.report?.drivers ?? []).filter((d) => (d.driver === "claude" || d.driver === "codex") && d.installed);
  const off = reported !== undefined ? !reported : !!mac?.version && installed.length > 0 && installed.every((d) => d.signedIn === undefined);
  let reason = "No reading yet. One comes in within five minutes.";
  let fix: string | undefined;
  let control: ReactNode | undefined;
  if (!mac) reason = "Its computer is no longer connected to this account.";
  else if (!mac.online) reason = "Its Mac is offline, so no reading comes in.";
  else if (mac.report?.drivers.some((d) => d.driver === inst.driver && d.installed && d.signedIn === false)) reason = `Not signed in on ${who}, so there is no plan to read.`;
  else if (off) {
    reason = "Plan limits are off on this Mac.";
    if (reported !== undefined) control = <Button size="sm" variant="outline" onClick={() => tell("limits:on")}>Turn on</Button>;
    else
      fix = here
        ? "Turn on Read this Mac's Claude and Codex limits under This Mac."
        : `Open the Mac app on ${who} and turn on Read this Mac's Claude and Codex limits under This Mac.`;
  }
  return <Row title={`${inst.name} on ${who}`} description={reason} status={fix} control={control} />;
}

function WindowBar({ w, now }: { w: LimitWindow; now: number }) {
  const left = leftOf(w.usedPercent);
  const reset = resetsIn(w, now);
  const low = left <= LOW;
  return (
    <Row
      title={w.label}
      control={
        <span className={cn("text-xs tabular-nums", low ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {left}% left{reset ? ` · ${reset}` : ""}
        </span>
      }
    >
      <div role="meter" aria-label={`${w.label}: ${left}% left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", low ? "bg-amber-500" : "bg-foreground/60")} style={{ width: `${left}%` }} />
      </div>
    </Row>
  );
}

function staleLine(i: LimitsIdentity, now: number): string | undefined {
  const age = now - i.at;
  if (!i.online) return `Mac offline · last reading ${ago(age)} ago`;
  if (age > STALE_MS) return `Reading ${ago(age)} old`;
  return undefined;
}

/** "12 min", "3 h", "2 days": how old a reading is. */
function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

type Line = { key: string; tool: string; ai: string; paid: boolean; calls: number; tokens: number; costUsd: number };

const sum = (ls: Line[]) => ls.reduce((t, l) => ({ calls: t.calls + l.calls, tokens: t.tokens + l.tokens, costUsd: t.costUsd + l.costUsd }), { calls: 0, tokens: 0, costUsd: 0 });

function aiNameOf(view: ProvidersView, r: UsageRow): string {
  if (!r.instance) return "Not tied to an AI";
  const set = r.scope === "workspace" ? view.workspace?.settings : view.own;
  const name = set?.instances.find((i) => i.id === r.instance)?.name ?? "Removed AI";
  return r.scope === "workspace" ? `${name} · team` : name;
}

/** One line per tool and AI for the period: calls, tokens and what they cost at API prices, biggest first. */
function linesOf(view: ProvidersView, since: number): Line[] {
  const out = new Map<string, Line>();
  for (const r of view.usage) {
    if (Date.parse(`${r.hour}:00:00Z`) < since) continue;
    const paid = r.label.endsWith(API);
    const base = paid ? r.label.slice(0, -API.length) : r.label;
    const tool = TOOL[base] ?? base;
    const ai = paid ? "Anthropic API key" : aiNameOf(view, r);
    const key = `${tool}\n${ai}`;
    const line = out.get(key) ?? { key, tool, ai, paid, calls: 0, tokens: 0, costUsd: 0 };
    line.calls += r.calls;
    line.tokens += r.tokens;
    line.costUsd += r.costUsd;
    out.set(key, line);
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

function Activity({ view, days, onDays }: { view: ProvidersView; days: number; onDays: (d: number) => void }) {
  const period = USAGE_PERIODS.find((p) => p.id === days)?.label.toLowerCase() ?? `${days} days`;
  const lines = linesOf(view, usageSince(days));
  const total = sum(lines);
  const paid = sum(lines.filter((l) => l.paid));
  return (
    <Section id="activity" title="Activity" action={<PeriodPicker value={days} onChange={onDays} />}>
      <Card>
        <Row
          title={total.calls ? `${total.calls} calls · ${tokensLabel(total.tokens)} tokens in the last ${period}` : `No AI calls in the last ${period}`}
          description={paid.calls ? `On the app's own key: $${paid.costUsd.toFixed(2)}` : undefined}
        />
        {lines.length > 0 && (
          <div className="overflow-x-auto px-3 py-2 sm:px-4">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4 font-medium">Tool</th>
                  <th className="py-1.5 pr-4 font-medium">AI</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Calls</th>
                  <th className="hidden py-1.5 pr-4 text-right font-medium sm:table-cell">Tokens</th>
                  <th className="py-1.5 text-right font-medium">Cost at API prices</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-border/50">
                    <td className="py-2 pr-4 text-foreground">{l.tool}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{l.ai}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{l.calls}</td>
                    <td className="hidden py-2 pr-4 text-right tabular-nums text-muted-foreground sm:table-cell">{tokensLabel(l.tokens)}</td>
                    <td className="py-2 text-right tabular-nums">${l.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Section>
  );
}

/** 24 h, 7 d, 30 d, 90 d: short enough for a phone's header beside the title. */
function PeriodPicker({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Period" className="flex gap-1">
      {USAGE_PERIODS.map((p) => (
        <Button
          key={p.id}
          size="xs"
          variant={value === p.id ? "secondary" : "ghost"}
          role="radio"
          aria-checked={value === p.id}
          onClick={() => onChange(p.id)}
        >
          {p.id === 1 ? "24 h" : `${p.id} d`}
        </Button>
      ))}
    </div>
  );
}
