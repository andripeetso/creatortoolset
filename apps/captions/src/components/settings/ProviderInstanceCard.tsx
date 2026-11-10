import type { ReactNode } from "react";
import { Link } from "react-router";
import { Terminal } from "lucide-react";
import { DRIVERS, type Driver, type MacReport, type ProviderCheck, type ProviderInstance, type ProviderSettings } from "@contracts/providers";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { hasProviderLogo, ProviderLogo } from "./ProviderLogos";
import { ListRow, Status } from "./ui";

export interface ProviderStatus {
  /** attention = the person must act (amber, with the button that fixes it); broken = a check failed (red); neutral = a fact or nothing */
  tone: "attention" | "broken" | "neutral";
  text: string;
  /** the button that fixes it, shown beside the switch: a sign-in, an install, or a new test */
  action?: "sign-in" | "install" | "test";
}

/**
 * One AI's status line, the first that applies: switched off (nothing: the switch says it), a tool the Mac app can't run,
 * a computer that is offline, the tool not installed there, a failed check, signed out, signed in (its plan, else
 * nothing). `report` = the computer has reported at all; `found` = what it reported for this tool.
 */
export function providerStatus(o: {
  enabled: boolean;
  runs: boolean;
  online: boolean;
  report: boolean;
  found?: MacReport["drivers"][number];
  /** when the computer last reported (ms): a result newer than that outranks a "not signed in" from the report */
  reportAt?: number;
  check?: ProviderCheck;
}): ProviderStatus {
  if (!o.enabled) return { tone: "neutral", text: "" };
  if (!o.runs) return { tone: "neutral", text: "Not in the Mac app yet" };
  if (!o.online) return { tone: "neutral", text: "Computer offline" };
  if (o.report && !o.found?.installed) return { tone: "attention", text: "Not installed", action: "install" };
  const answeredSinceReport = !!o.check?.ok && (o.reportAt === undefined || o.check.at >= o.reportAt);
  if (o.found?.signedIn === false && !answeredSinceReport) return { tone: "attention", text: "Not signed in", action: "sign-in" };
  if (o.check && !o.check.ok) {
    // the plain reason is in the detail; a sign-in problem gets its fix on the row
    const signIn = /sign in|log ?in|login/i.test(o.check.error ?? "");
    const computer = /did not pick up|is offline|stopped answering/i.test(o.check.error ?? "");
    return { tone: "broken", text: computer ? "Computer didn't answer" : "Didn't answer", action: signIn ? "sign-in" : "test" };
  }
  if (o.found?.signedIn && o.found.plan) return { tone: "neutral", text: `${o.found.plan.charAt(0).toUpperCase()}${o.found.plan.slice(1)} plan` };
  return { tone: "neutral", text: "" };
}

/** The settings with one provider changed and the rest left as they are. */
export function withInstance(set: ProviderSettings, id: string, patch: Partial<ProviderInstance>): ProviderSettings {
  return { ...set, instances: set.instances.map((i) => (i.id === id ? { ...i, ...patch } : i)) };
}

/**
 * Whether the Mac reports a custom API endpoint for this provider's Claude folder. The folder is matched by its last
 * name, since an instance keeps the path as it was picked; an empty home is the default ~/.claude.
 */
export function hasCustomEndpoint(report: MacReport | null, inst: ProviderInstance): boolean {
  if (inst.driver !== "claude" || !report) return false;
  const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";
  const want = inst.home ? folderName(inst.home) : ".claude";
  return report.homes.some((h) => h.driver === "claude" && h.customEndpoint === true && folderName(h.home) === want);
}

/** A tool's mark: its logo; the Local command gets a terminal glyph; only a tool no one drew falls back to two letters. */
export function DriverMark({ driver, className }: { driver: Driver; className?: string }) {
  if (driver === "acp") return <Terminal aria-hidden className={cn("size-4 text-muted-foreground", className)} />;
  if (hasProviderLogo(driver)) return <ProviderLogo driver={driver} className={cn("size-4", className)} />;
  const label = DRIVERS.find((x) => x.id === driver)?.label ?? driver;
  return (
    <span aria-hidden className={cn("flex size-4 items-center justify-center text-[9px] font-semibold text-muted-foreground", className)}>
      {label.slice(0, 2)}
    </span>
  );
}

export function ProviderMark({ inst, className }: { inst: ProviderInstance; className?: string }) {
  return <DriverMark driver={inst.driver} className={className} />;
}

/**
 * A provider's row in the list: its logo, name and version, one status line, the button its status needs, and the
 * on/off switch. The name is the link to its detail. `onToggle` absent = a read-only row (the team's AI).
 */
export function ProviderInstanceCard({
  inst,
  status,
  version,
  selected,
  href,
  action,
  onToggle,
}: {
  inst: ProviderInstance;
  status: ProviderStatus;
  version?: string;
  selected?: boolean;
  /** the detail's address; the name links there (absent: nothing to open) */
  href?: string;
  /** the button the status needs (Sign in, Install) */
  action?: ReactNode;
  onToggle?: (on: boolean) => void;
}) {
  return (
    <ListRow
      className={cn("relative min-h-[4.5rem]", selected && "bg-accent/40")}
      icon={<ProviderMark inst={inst} />}
      title={
        <>
          {href ? (
            <Link to={href} className="rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring">
              {inst.name}
            </Link>
          ) : (
            inst.name
          )}
          {version && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">v{version}</span>}
        </>
      }
      status={status.text ? <Status tone={status.tone === "neutral" ? undefined : status.tone}>{status.text}</Status> : undefined}
      actions={
        <div className="relative z-10 flex items-center gap-2">
          {action}
          {onToggle && <Switch checked={inst.enabled} onCheckedChange={onToggle} aria-label={`Use ${inst.name}`} />}
        </div>
      }
    />
  );
}
