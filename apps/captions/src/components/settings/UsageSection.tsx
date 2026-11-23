import { useEffect, type ReactNode } from "react";
import { DRIVERS, type LimitsIdentity, type LimitWindow, type ProviderInstance, type ProvidersView } from "@contracts/providers";
import { PLANS, planFromCli, type PlanId } from "@contracts/plans";
import type { SetupView } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { deviceOf, thisMacDevice } from "@/lib/providers";
import { LOW, countedWindow, identityKey, leftOf, noticeOf, resetsIn } from "@/lib/limits";
import { useSetup } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "./ProviderLogos";
import { Card, EmptyRow, ListRow, Row, Section, SettingsSelect, Status, saveFailed, markSave } from "./ui";
import { tell, type ThisMacState } from "./ThisMacSection";

const STALE_MS = 15 * 60_000;

/**
 * The plan left on each AI sign-in, for the Usage page's Limits (pages/UsagePage.tsx), and the Plan row Settings →
 * Providers shows.
 */

/** One card per AI login with a reading, then one row for each Claude or Codex AI that has none, with the true reason. */
export function PlanLimits({ view, now, bridge }: { view: ProvidersView; now: number; bridge: ThisMacState | null }) {
  const logins = [...view.limits].sort((a, b) => (a.driver === b.driver ? a.label.localeCompare(b.label) : a.driver === "claude" ? -1 : 1));
  const unread = missingReadings(view);
  if (logins.length === 0 && unread.length === 0) {
    return (
      <Section title="Plan limits">
        <Card>
          {view.teamAi ? (
            // on the team's key there is no plan of their own to read: the budget is the limit
            <EmptyRow title="Team budget" description={`$${view.teamAi.spentUsd.toFixed(2)} of $${view.teamAi.budgetUsd} spent this month.`} />
          ) : (
            <EmptyRow title="No plan limits" />
          )}
        </Card>
      </Section>
    );
  }
  return (
    <Section title="Plan limits">
      {logins.map((i) => (
        <LoginCard key={identityKey(i)} i={i} view={view} now={now} />
      ))}
      {unread.length > 0 && (
        <Card>
          {unread.map(({ inst, device, hit }, n) => (
            <Unread key={n} inst={inst} device={device} view={view} bridge={bridge} hit={hit} />
          ))}
        </Card>
      )}
    </Section>
  );
}

/**
 * "Plan" (Settings → Providers): the person's pick, else the plan their AI names (setup's `detected`: Claude's sign-in,
 * Codex's usage page), else Not set. It is what a heavy run reads before it starts (confirmHeavy in lib/setup.ts; it asks
 * first on Pro and Plus). Picking one saves it as theirs; nothing the AI says replaces it. A row of the caller's card.
 */
export function YourPlan() {
  const setup = useSetup((s) => s.view);
  useEffect(() => void useSetup.getState().load(), []);
  return setup ? <PlanRow setup={setup} /> : null;
}

export function PlanRow({ setup }: { setup: SetupView }) {
  const save = (v: string) => void markSave(useSetup.getState().save({ plan: v === "none" ? null : (v as PlanId) })).catch(() => saveFailed("That did not save. Try again."));
  // the first choice follows the account: the plan it names, or Not set when it names none. Choosing it drops a pick
  // made by hand, so every choice in the list does something (Not set beside a found plan used to jump straight back)
  const found = PLANS.find((x) => x.id === setup.detected);
  return (
    <Row
      id="your-plan"
      title="Plan"
      description="On Pro or Plus, big jobs start after a confirmation."
      control={
        <SettingsSelect
          label="Plan"
          value={setup.plan ?? "none"}
          onValueChange={save}
          options={[{ value: "none", label: found ? `${found.label} (detected)` : "Not set" }, ...PLANS.map((p) => ({ value: p.id, label: p.label }))]}
        />
      }
    />
  );
}

/** The enabled Claude and Codex AIs this account sees that have no reading (a login names its instances in `instances`). */
function missingReadings(view: ProvidersView): Array<{ inst: ProviderInstance; device: string; hit?: string }> {
  // the AI's check is keyed by scope: "workspace:<id>", or the account's own "<username>:<id>"
  const hitOf = (id: string, own: boolean) => Object.entries(view.checks ?? {}).find(([k]) => k.endsWith(`:${id}`) && k.startsWith("workspace:") !== own)?.[1].note;
  const sets = [
    ...(view.own?.instances ?? []).map((inst) => ({ inst, hit: hitOf(inst.id, true) })),
    ...(view.workspace?.settings.instances ?? []).map((inst) => ({ inst, hit: hitOf(inst.id, false) })),
  ];
  return sets
    .filter(({ inst: i }) => i.enabled && (i.driver === "claude" || i.driver === "codex"))
    .map(({ inst, hit }) => ({ inst, hit, device: deviceOf(inst) }))
    .filter(({ inst, device }) => !view.limits.some((l) => l.driver === inst.driver && l.device === device && l.instances.some((k) => k.endsWith(`:${inst.id}`))));
}

/** One AI login: its logo, name, computer and plan, then a bar per window with the share left and when it resets. */
function LoginCard({ i, view, now }: { i: LimitsIdentity; view: ProvidersView; now: number }) {
  const mac = view.devices.find((d) => d.id === i.device);
  // Codex's plan comes with its reading; Claude's from its sign-in, in the Mac's report
  const planId = i.plan ?? (i.driver === "claude" ? planFromCli(mac?.report?.drivers.find((d) => d.driver === "claude")?.plan) : null);
  const plan = PLANS.find((p) => p.id === planId)?.label;
  const driver = DRIVERS.find((d) => d.id === i.driver)?.label ?? i.driver;
  // the Mac reports each Claude folder with whether it has a custom endpoint; the folder is named ".claude" or ".claude-<label>"
  const folder = i.label === "default" ? `.${i.driver}` : `.${i.driver}-${i.label}`;
  const custom = !!mac?.report?.homes.some((h) => h.driver === i.driver && h.home.split("/").pop() === folder && h.customEndpoint);
  const notice = noticeOf(i, custom);
  // the title is the name of the AI it answers ("Claude (hub)"); the folder's label only when no AI is named
  const all = [...(view.own?.instances ?? []), ...(view.workspace?.settings.instances ?? [])];
  const names = [...new Set(i.instances.map((k) => all.find((x) => x.id === k.slice(k.indexOf(":") + 1))?.name).filter((n): n is string => !!n))];
  const title = names.length ? names.join(" · ") : i.label === "default" ? driver : `${driver} · ${i.label}`;
  return (
    <Card>
      <ListRow
        icon={<ProviderLogo driver={i.driver} className="size-4" />}
        title={title}
        subtitle={[plan ? `${plan} plan` : null, mac?.name].filter(Boolean).join(" · ") || undefined}
        status={staleLine(i, now)}
      />
      {i.state === "ok" && i.windows.map((w) => <WindowBar key={w.id} w={countedWindow(i, w, now)} now={now} />)}
      {notice && <div className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">{notice}</div>}
    </Card>
  );
}

/**
 * An AI provider with no reading: the true state of its computer, and the fix where the person can make one. On this
 * Mac, a Mac app that reports its switch (`bridge.limits`) turns it on from the row; elsewhere the row names the fix.
 */
function Unread({ inst, device, view, bridge, hit }: { inst: ProviderInstance; device: string; view: ProvidersView; bridge: ThisMacState | null; hit?: string }) {
  const mac = view.devices.find((d) => d.id === device);
  const who = mac?.name ?? "another computer";
  const here = thisMacDevice() === device;
  const reported = here && typeof bridge?.limits === "boolean" ? bridge.limits : undefined;
  // the Mac app reports its version, the worker does not; a Mac app posts no sign-in state while its switch is off
  const installed = (mac?.report?.drivers ?? []).filter((d) => (d.driver === "claude" || d.driver === "codex") && d.installed);
  const off = reported !== undefined ? !reported : !!mac?.version && installed.length > 0 && installed.every((d) => d.signedIn === undefined);
  const signedOut = !!mac?.online && !!mac.report?.drivers.some((d) => d.driver === inst.driver && d.installed && d.signedIn === false);
  const title = `${inst.name} on ${who}`;
  // the same state Providers shows, in amber: the sign-in itself is on that page
  if (signedOut) return <Row title={title} status={<Status tone="attention">Not signed in</Status>} />;
  let state: string | undefined;
  let fix: string | undefined = "The first reading takes up to five minutes.";
  let control: ReactNode | undefined;
  if (!mac) [state, fix] = ["Computer removed", undefined];
  else if (!mac.online) [state, fix] = ["Computer offline", undefined];
  else if (off) {
    state = "Plan limits off";
    fix = undefined;
    if (reported !== undefined) control = <Button size="sm" variant="outline" onClick={() => tell("limits:on")}>Turn on</Button>;
    else fix = `Turn on plan limits in the Mac app on ${who}.`;
  }
  // its last call met the plan's limit (the provider's check note, mac-claude.ts): that, in amber, says more than "no reading"
  if (hit) return <Row title={title} status={<Status tone="attention">{hit}</Status>} description={off ? "Turn on plan limits to see how much is left." : undefined} control={control} />;
  return <Row title={title} description={fix} status={state} control={control} />;
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
  if (!i.online) return `Computer offline · last reading ${ago(age)} ago`;
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
