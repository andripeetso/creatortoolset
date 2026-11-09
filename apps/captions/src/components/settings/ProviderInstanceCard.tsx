import type { CSSProperties } from "react";
import { DRIVERS, type MacReport, type ProviderCheck, type ProviderInstance, type ProviderSettings } from "@contracts/providers";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type StatusTone = "ready" | "warning" | "error" | "neutral" | "disabled";

export interface ProviderStatus {
  tone: StatusTone;
  text: string;
}

const TONE_DOT: Record<StatusTone, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  neutral: "bg-muted-foreground/40",
  disabled: "bg-muted-foreground/20",
};

const TONE_TEXT: Record<StatusTone, string> = {
  ready: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

/**
 * One provider's status line, the first thing that applies: off, a driver the Mac app can't run, its Mac offline,
 * the CLI not installed, a failed check, signed out, signed in (with its plan), else ready after a check or not checked.
 * `report` = the Mac has reported at all; `found` = what it reported for this provider's driver.
 */
export function providerStatus(o: {
  enabled: boolean;
  runs: boolean;
  online: boolean;
  report: boolean;
  found?: MacReport["drivers"][number];
  check?: ProviderCheck;
}): ProviderStatus {
  if (!o.enabled) return { tone: "disabled", text: "Disabled" };
  if (!o.runs) return { tone: "neutral", text: "The Mac app doesn't run it yet" };
  if (!o.online) return { tone: "neutral", text: "Mac offline" };
  if (o.report && !o.found?.installed) return { tone: "warning", text: "Not installed on this Mac" };
  if (o.check && !o.check.ok) return { tone: "error", text: o.check.error || "The check failed" };
  if (o.found?.signedIn === false) return { tone: "warning", text: "Not signed in" };
  if (o.found?.signedIn) return { tone: "ready", text: o.found.plan ? `Authenticated · ${o.found.plan}` : "Authenticated" };
  if (o.check?.ok) return { tone: "ready", text: "Ready" };
  return { tone: "neutral", text: "Not checked" };
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

/** The provider's mark: its driver's two letters, in its accent colour when it has one. */
export function ProviderMark({ inst }: { inst: ProviderInstance }) {
  const label = DRIVERS.find((x) => x.id === inst.driver)?.label ?? inst.driver;
  const style: CSSProperties | undefined = inst.accentColor ? { color: inst.accentColor, borderColor: inst.accentColor } : undefined;
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-[11px] font-semibold",
        !inst.accentColor && "text-violet-600 dark:text-violet-300",
      )}
    >
      {label.slice(0, 2)}
    </span>
  );
}

/** A status line: a coloured dot and its text. */
export function StatusText({ status }: { status: ProviderStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[status.tone])} />
      <span className={TONE_TEXT[status.tone]}>{status.text}</span>
    </span>
  );
}

/**
 * A provider's row in the list: the name with its version, the status line, and an on/off switch. The row's
 * text selects the provider for the detail pane below. Members (`readOnly`) see the row without the switch.
 */
export function ProviderInstanceCard({
  inst,
  status,
  version,
  selected,
  readOnly,
  where,
  customEndpoint,
  onSelect,
  onToggle,
}: {
  inst: ProviderInstance;
  status: ProviderStatus;
  version?: string;
  selected: boolean;
  readOnly: boolean;
  /** the Mac reports this Claude folder points at a custom API endpoint (see hasCustomEndpoint) */
  customEndpoint?: boolean;
  /** the Mac that runs it, named to members who don't see the Mac list */
  where?: string;
  onSelect: () => void;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className={cn("flex items-center gap-3 px-3 py-3", selected && "bg-accent/40")}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
      >
        <ProviderMark inst={inst} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="break-words text-foreground">{inst.name}</span>
            {version && <span className="text-xs text-muted-foreground">v{version}</span>}
            {customEndpoint && <span className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">Custom API endpoint</span>}
          </span>
          <span className="mt-0.5 block text-[11px]">
            <StatusText status={status} />
            {where && <span className="text-muted-foreground"> · on {where}</span>}
          </span>
        </span>
      </button>
      {!readOnly && (
        <Switch checked={inst.enabled} aria-label={`Turn ${inst.name} ${inst.enabled ? "off" : "on"}`} onCheckedChange={onToggle} />
      )}
    </div>
  );
}
