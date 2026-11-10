import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { DRIVERS, type Driver, type DriverCatalog, type MacReport, type PresetView, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { msg } from "./helpers";
import { DriverMark } from "./ProviderInstanceCard";
import { InstallHelp } from "./AiSetup";
import { FormDialog } from "./ui";

/** The sign-in each tool has, for the line that says to sign in on the computer. */
const SIGN_IN: Partial<Record<Driver, string>> = { codex: "codex login", claude: "claude", grok: "grok login", gemini: "gemini" };

/** The id a new AI gets: "~/.claude-work" → "claude_work"; no folder → the tool's id. Starts with a letter, unique. */
export function instanceId(driver: Driver, home: string, taken: string[]): string {
  let base = home.trim() ? basename(home).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) : "";
  if (base && !/^[a-z]/.test(base)) base = `${driver}_${base}`;
  base = base || driver;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

/** "Claude (work)" for ~/.claude-work; "Codex (default)" with no folder. */
export function defaultName(driver: Driver, home: string): string {
  const label = DRIVERS.find((d) => d.id === driver)?.label ?? driver;
  const part = basename(home).replace(/^\./, "").replace(/^(claude|codex|grok|gemini)[-_]?/i, "") || "default";
  return `${label} (${part})`;
}

/**
 * The one way an AI is built from the add dialog's answers: the tool, its folder (empty = the tool's default), its name, the
 * computer that runs it, and for the local command its program. The Settings page sends it on; setup's Connect builds the
 * same shape on the server (addInstanceTo).
 */
export function buildInstance(o: { driver: Driver; home?: string; name: string; device: string; takenIds: string[]; command?: string }): ProviderInstance {
  const home = (o.home ?? "").trim();
  return {
    id: instanceId(o.driver, home, o.takenIds),
    driver: o.driver,
    name: o.name.trim(),
    enabled: true,
    device: o.device,
    ...(home ? { home } : {}),
    ...(o.driver === "acp" && o.command?.trim() ? { acp: { command: o.command.trim(), args: [] } } : {}),
  };
}

function basename(home: string): string {
  return home.trim().replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * The tool tiles, one grid for every path. Tools the computer has come first and say "Installed"; the featured ones follow;
 * the rest sit behind "Show more". A tool the Mac app can't run is disabled with the server's reason.
 */
export function ToolGrid({
  catalog,
  report,
  driver,
  showMore,
  presets,
  onPick,
  onPreset,
  onToggleMore,
}: {
  catalog: DriverCatalog | null;
  report: MacReport | null;
  driver: Driver | null;
  showMore: boolean;
  /** a plug-in's ready-made AI, shown as a tile */
  presets?: PresetView[];
  onPick: (d: Driver) => void;
  onPreset?: (p: PresetView) => void;
  onToggleMore: () => void;
}) {
  const all: Array<{ id: Driver; label: string; featured: boolean }> = [
    ...DRIVERS.map((d) => ({ id: d.id as Driver, label: d.label, featured: d.featured })),
    ...(catalog?.drivers ?? []).filter((e) => !DRIVERS.some((d) => d.id === e.id)).map((e) => ({ id: e.id, label: e.label, featured: e.featured })),
  ];
  const installed = (id: Driver) => !!report?.drivers.find((x) => x.driver === id)?.installed;
  const shown = all
    .filter((d) => d.featured || installed(d.id) || showMore)
    .sort((a, b) => Number(installed(b.id)) - Number(installed(a.id)));
  const tile = (d: { id: Driver; label: string }) => {
    const entry = catalog?.drivers.find((x) => x.id === d.id);
    const runs = !!entry?.runs;
    return (
      <Tile
        key={d.id}
        driver={d.id}
        label={d.label}
        selected={driver === d.id}
        disabled={!!catalog && !runs}
        sub={!catalog ? undefined : !runs ? (entry?.reason ?? "Not available here") : installed(d.id) ? "Installed" : undefined}
        onClick={() => onPick(d.id)}
      />
    );
  };
  const presetTile = (p: PresetView) => {
    const runs = !!catalog?.drivers.find((d) => d.id === p.driver)?.runs;
    return <Tile key={`preset-${p.id}`} driver={p.driver} label={p.name} selected={false} disabled={!runs || !onPreset} sub={p.badge} onClick={() => onPreset?.(p)} />;
  };
  const hidden = all.some((d) => !d.featured && !installed(d.id));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(presets ?? []).map(presetTile)}
        {shown.map(tile)}
      </div>
      {hidden && (
        <button type="button" aria-expanded={showMore} onClick={onToggleMore} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          {showMore ? "Show less" : "Show more"}
          <ChevronDown className={cn("size-3.5 transition-transform", showMore && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

function Tile({ driver, label, selected, disabled, sub, onClick }: { driver: Driver; label: string; selected: boolean; disabled: boolean; sub?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/60 hover:bg-accent/50",
      )}
    >
      <DriverMark driver={driver} className="size-5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
      {selected && (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
      )}
    </button>
  );
}

/**
 * Settings → Providers → Add provider: one dialog for every path. Pick the tool; if the computer has more than one folder for
 * it, pick the account (only then); name it. A tool the computer lacks or is signed out of gets its one help line.
 */
export function AddProviderDialog({
  deviceName,
  report,
  instances,
  initialDriver,
  onClose,
  onAdd,
}: {
  deviceName: string;
  report: MacReport | null;
  instances: ProviderInstance[];
  /** a tool to start on (an installed one listed on the page) */
  initialDriver?: Driver;
  onClose: () => void;
  /** Adds the AI to the page's set (the page sets its computer). Throws a sentence when it can't. */
  onAdd: (inst: ProviderInstance) => Promise<void>;
}) {
  const [driver, setDriver] = useState<Driver | null>(initialDriver ?? null);
  const [showMore, setShowMore] = useState(false);
  const [home, setHome] = useState("");
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<DriverCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/providers/drivers")
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as (DriverCatalog & { error?: string }) | null;
        if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
        return j as DriverCatalog;
      })
      .then(setCatalog)
      .catch((e: unknown) => setCatalogError(msg(e)));
  }, []);

  const entry = catalog?.drivers.find((d) => d.id === driver);
  const runs = !!entry?.runs;
  const found = driver ? report?.drivers.find((x) => x.driver === driver) : undefined;
  const homes = driver ? (report?.homes ?? []).filter((h) => h.driver === driver).map((h) => h.home) : [];
  // one folder on the computer is that account; several need the person to pick one
  const chosenHome = homes.length > 1 ? home : homes.length === 1 ? homes[0]! : "";
  const label = driver ? (nameDraft ?? defaultName(driver, chosenHome)) : "";
  const duplicate = !!driver && instances.some((i) => i.driver === driver && (i.home ?? "") === chosenHome.trim());
  const toolLabel = DRIVERS.find((d) => d.id === driver)?.label ?? entry?.label ?? "";
  const signIn = driver ? SIGN_IN[driver] : undefined;

  const pick = (d: Driver) => {
    setDriver(d);
    setHome("");
    setNameDraft(null);
    setCommand("");
    setError(null);
  };

  const submit = async () => {
    if (!driver) return setError("Choose the AI first.");
    if (!runs) return setError(entry?.reason ?? "The Mac app can't run this yet.");
    if (!label.trim()) return setError("Give it a name.");
    if (duplicate) return setError("That account is already added on this computer.");
    if (driver === "acp" && !command.trim()) return setError("Give the command that starts it.");
    setBusy(true);
    setError(null);
    try {
      // the page sets the computer it adds to
      await onAdd(buildInstance({ driver, home: chosenHome, name: label, device: "", takenIds: instances.map((i) => i.id), command }));
      onClose();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add provider"
      description={`Add an AI tool on ${deviceName}.`}
      submitLabel="Add provider"
      onSubmit={submit}
      busy={busy}
      error={error ?? catalogError}
    >
      <ToolGrid
        catalog={catalog}
        report={report}
        driver={driver}
        showMore={showMore}
        onPick={pick}
        onToggleMore={() => setShowMore((s) => !s)}
      />

      {driver && homes.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-sm text-foreground">Which {toolLabel} account?</p>
          <p className="text-xs text-muted-foreground">Each folder on the computer holds one.</p>
          <div className="flex flex-col gap-1.5">
            {["", ...homes].map((h) => (
              <Button key={h || "default"} variant={chosenHome === h ? "secondary" : "outline"} size="sm" className="justify-start font-normal" onClick={() => setHome(h)}>
                <span className={cn(h && "font-mono text-xs")}>{h || "Default folder"}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {driver && (
        <div className="space-y-1.5">
          <label htmlFor="add-ai-name" className="text-xs text-muted-foreground">
            Name
          </label>
          <Input id="add-ai-name" value={label} onChange={(e) => setNameDraft(e.target.value)} className="h-8 text-sm" />
        </div>
      )}

      {driver === "acp" && (
        <div className="space-y-1.5">
          <label htmlFor="add-ai-command" className="text-xs text-muted-foreground">
            Command that starts it
          </label>
          <Input id="add-ai-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx some-agent acp" className="h-8 font-mono text-xs" />
        </div>
      )}

      {driver && found && !found.installed && report && <InstallHelp driver={driver} />}
      {driver && runs && found?.installed && found.signedIn === false && signIn && (
        <p className="text-xs text-muted-foreground">
          Then sign in on {deviceName}: run <code>{signIn}</code> once in Terminal there.
        </p>
      )}
    </FormDialog>
  );
}
