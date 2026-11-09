import { useEffect, useState } from "react";
import { DRIVERS, type Driver, type DriverCatalog, type MacReport, type PresetView, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Check, ChevronDown } from "lucide-react";
import { hasProviderLogo, ProviderLogo } from "./ProviderLogos";
import { InstallHelp } from "./AiSetup";

/** The server's rules (api/lib/providers.ts ID_RE, ENV_NAME_RE, ABS_PATH_RE): the dialog never offers what the server refuses. */
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ABS_PATH_RE = /^\/[^\0]{1,300}$/;

/** The sign-in each CLI has: the step 1 footer's "Continue with …" and the sign-in line in step 3. */
const SIGN_IN: Partial<Record<Driver, { label: string; command: string }>> = {
  codex: { label: "ChatGPT", command: "codex login" },
  claude: { label: "Claude", command: "claude" },
  grok: { label: "Grok", command: "grok login" },
};

/** The reason an instance id can't be saved, or null. Starts with a letter; letters, digits, - and _; at most 60; not taken. */
export function validateInstanceId(id: string, taken: string[]): string | null {
  if (!id) return "Give the provider an id";
  if (!/^[A-Za-z]/.test(id)) return "The id starts with a letter";
  if (!ID_RE.test(id)) return "The id is letters, digits, - and _, at most 60 characters";
  if (taken.includes(id)) return "Another provider already has this id";
  return null;
}

/**
 * Step 1's grid: the featured drivers in the wizard's order, then "Show more" for the rest. A driver the Mac app can't
 * run yet is shown disabled, with the catalog's reason. Before the catalog loads, every driver is disabled.
 */
export function DriverGrid({
  catalog,
  driver,
  showMore,
  onPick,
  onPreset,
  onToggleMore,
}: {
  catalog: DriverCatalog | null;
  driver: Driver | null;
  showMore: boolean;
  onPick: (d: Driver) => void;
  /** a plug-in preset's row: its driver, folder and name are filled in */
  onPreset?: (p: PresetView) => void;
  onToggleMore: () => void;
}) {
  // the built-in drivers in order, then any driver kind a plug-in adds (from the catalog)
  const all: Array<{ id: Driver; label: string; featured: boolean }> = [
    ...DRIVERS.map((d) => ({ id: d.id, label: d.label, featured: d.featured })),
    ...(catalog?.drivers ?? []).filter((e) => !DRIVERS.some((d) => d.id === e.id)).map((e) => ({ id: e.id, label: e.label, featured: e.featured })),
  ];
  const tile = (d: { id: Driver; label: string; featured: boolean }) => {
    const entry = catalog?.drivers.find((x) => x.id === d.id);
    const runs = !!entry?.runs;
    return (
      <Tile
        key={d.id}
        driverId={d.id}
        label={d.label}
        selected={driver === d.id}
        disabled={!runs}
        reason={catalog && !runs ? (entry?.reason ?? "Not available here") : undefined}
        onClick={() => onPick(d.id)}
      />
    );
  };
  const presetRow = (p: PresetView) => {
    const runs = !!catalog?.drivers.find((d) => d.id === p.driver)?.runs;
    return <Tile key={`preset-${p.id}`} driverId={p.driver} label={p.name} selected={false} disabled={!runs || !onPreset} onClick={() => onPreset?.(p)} />;
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {(catalog?.presets ?? []).map(presetRow)}
        {all.filter((d) => d.featured).map(tile)}
        {showMore && all.filter((d) => !d.featured).map(tile)}
      </div>
      <button type="button" aria-expanded={showMore} onClick={onToggleMore} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        {showMore ? "Show less" : "Show more"}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showMore && "rotate-180")} />
      </button>
    </div>
  );
}

/** One provider in the grid: its logo and name; selected = blue border and a check. `reason` shows only where it can't be picked. */
function Tile({
  driverId,
  label,
  selected,
  disabled,
  reason,
  onClick,
}: {
  driverId: Driver;
  label: string;
  selected: boolean;
  disabled: boolean;
  reason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-blue-600 bg-blue-500/10 ring-1 ring-blue-600" : "border-border hover:bg-accent",
      )}
    >
      {hasProviderLogo(driverId) ? (
        <ProviderLogo driver={driverId} className="h-5 w-5 shrink-0" />
      ) : (
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-muted text-[9px] font-semibold">
          {(DRIVERS.find((d) => d.id === driverId)?.label ?? driverId).slice(0, 2)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {reason && <span className="mt-0.5 block text-xs text-muted-foreground">{reason}</span>}
      </span>
      {selected && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}

/** The primary button of the dialog: blue, like the sign-in it continues with. */
const PRIMARY = "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-600/50";
const STEPS = ["Provider", "Identity", "Config"] as const;

/**
 * Settings → Your AI → Add your AI. Three steps: Provider (the grid), Identity (config folder, name, id), Config
 * (on, and for Configure manually: program or ACP command, arguments, environment variable names). Configure manually
 * skips the sign-in and goes to Identity; a driver the Mac app can't run is disabled in the grid.
 */
export function AddProviderDialog({
  deviceName,
  report,
  instances,
  onClose,
  onAdd,
}: {
  deviceName: string;
  report: MacReport | null;
  instances: ProviderInstance[];
  onClose: () => void;
  /** Adds the instance to the page's set (the page sets its device). */
  onAdd: (inst: ProviderInstance) => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [driver, setDriver] = useState<Driver | null>(null);
  // the plug-in preset the row was picked from (sent with the instance; the server adds its endpoint)
  const [presetId, setPresetId] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [manual, setManual] = useState(false);
  const [home, setHome] = useState("");
  // null = not edited: the name and id follow the driver and the folder
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [idDraft, setIdDraft] = useState<string | null>(null);
  const [program, setProgram] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
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
      .catch((e: unknown) => setCatalogError(e instanceof Error ? e.message : String(e)));
  }, []);

  const entry = catalog?.drivers.find((d) => d.id === driver);
  const info = DRIVERS.find((d) => d.id === driver) ?? (entry && { id: entry.id, label: entry.label, featured: entry.featured });
  const runs = !!entry?.runs;
  const homes = driver ? (report?.homes ?? []).filter((h) => h.driver === driver).map((h) => h.home) : [];
  const takenIds = instances.map((i) => i.id);
  const label = nameDraft ?? (driver ? defaultName(driver, home) : "");
  const id = idDraft ?? (driver ? instanceId(driver, home, takenIds) : "");
  const idError = driver ? validateInstanceId(id, takenIds) : null;
  const duplicate = !!driver && instances.some((i) => i.driver === driver && (i.home ?? "") === home.trim());
  const login = driver ? SIGN_IN[driver] : undefined;

  const prog = program.trim();
  const argList = argsText.split("\n").map((s) => s.trim()).filter(Boolean);
  const envList = envText.split("\n").map((s) => s.trim()).filter(Boolean);
  const configError = !manual
    ? null
    : driver === "acp" && !prog
      ? "A local ACP command needs its program"
      : driver === "acp" && prog.length > 300
        ? "The ACP command is at most 300 characters"
        : driver !== "acp" && prog && !ABS_PATH_RE.test(prog)
          ? "The program's path must be a full path, like /opt/homebrew/bin/codex"
          : argList.length > 32 || argList.some((a) => a.length > 500)
            ? "Each argument is one piece of text, up to 32 of them"
            : envList.length > 32 || envList.some((n) => !ENV_NAME_RE.test(n))
              ? "Environment names are letters, digits and _, up to 32 of them"
              : null;

  const pick = (d: Driver) => {
    setDriver(d);
    setHome("");
    setNameDraft(null);
    setIdDraft(null);
    setManual(false);
    setPresetId(null);
  };

  // a preset row: its driver, folder and name are filled in, and the Identity step comes next
  const pickPreset = (p: PresetView) => {
    pick(p.driver);
    setHome(p.home ?? "");
    setNameDraft(p.name);
    setPresetId(p.id);
    setStep(2);
  };

  const add = async () => {
    if (!driver) return;
    const inst: ProviderInstance = {
      id,
      driver,
      name: label.trim(),
      enabled,
      ...(presetId ? { preset: presetId } : {}),
      ...(home.trim() ? { home: home.trim() } : {}),
      ...(manual && driver === "acp" ? { acp: { command: prog, args: argList } } : {}),
      ...(manual && driver !== "acp" && prog ? { binaryPath: prog } : {}),
      ...(manual && envList.length ? { envNames: envList } : {}),
    };
    setBusy(true);
    try {
      await onAdd(inst);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-4 sm:max-w-[40rem]">
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>Add an account or configure a provider on {deviceName}.</DialogDescription>
        </DialogHeader>

        <div role="group" aria-label="Steps" className="flex gap-1 rounded-xl bg-muted p-1">
          {STEPS.map((text, i) => {
            const n = i + 1;
            const on = step === n;
            return (
              <div
                key={text}
                aria-current={on ? "step" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                  on ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                    on ? "border-blue-600 text-blue-600" : "border-muted-foreground/40",
                  )}
                >
                  {n}
                </span>
                {text}
              </div>
            );
          })}
        </div>

        {step === 1 && (
          <>
            <p className="text-sm font-medium text-foreground">Provider</p>
            <DriverGrid
              catalog={catalog}
              driver={driver}
              showMore={showMore}
              onPick={pick}
              onPreset={pickPreset}
              onToggleMore={() => setShowMore((s) => !s)}
            />
            {catalogError && <p className="text-xs text-amber-600 dark:text-amber-400">Could not load which tools this app runs: {catalogError}</p>}
            {driver && report && !report.drivers.find((x) => x.driver === driver)?.installed && <InstallHelp driver={driver} />}
          </>
        )}

        {step === 2 && info && (
          <>
            <p className="text-sm text-muted-foreground">Which {info.label} account? Each folder on the Mac holds one.</p>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setHome("")}
                className={cn("rounded-lg border px-3 py-2 text-left text-sm", home === "" ? "border-blue-600 bg-blue-500/10" : "border-border hover:bg-accent")}
              >
                Default
              </button>
              {homes.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHome(h)}
                  className={cn("rounded-lg border px-3 py-2 text-left font-mono text-xs", home === h ? "border-blue-600 bg-blue-500/10" : "border-border text-muted-foreground hover:bg-accent")}
                >
                  {h}
                </button>
              ))}
            </div>
            {homes.length === 0 && <p className="text-xs text-muted-foreground">No folders found on the Mac for {info.label}. Use the default, or type one below.</p>}
            <label className="block text-xs text-muted-foreground">
              Or type its folder
              <input
                value={home}
                onChange={(e) => setHome(e.target.value)}
                placeholder="/Users/you/.claude-work"
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Name
              <input
                value={label}
                onChange={(e) => setNameDraft(e.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Provider id (what jobs point at)
              <input
                value={id}
                onChange={(e) => setIdDraft(e.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground focus:border-blue-500 focus:outline-none"
              />
            </label>
            {idError && <p className="text-xs text-amber-600 dark:text-amber-400">{idError}</p>}
            {duplicate && <p className="text-xs text-amber-600 dark:text-amber-400">That account is already added.</p>}
          </>
        )}

        {step === 3 && info && (
          <>
            {login && !manual && (
              <p className="text-xs text-muted-foreground">
                Sign in on {deviceName}: run <code>{login.command}</code> once in Terminal there.
              </p>
            )}
            {manual && (
              <>
                <label className="block text-xs text-muted-foreground">
                  {driver === "acp" ? "ACP command" : "Program"}
                  <input
                    value={program}
                    onChange={(e) => setProgram(e.target.value)}
                    placeholder={driver === "acp" ? "npx some-agent acp" : "Leave empty to use the CLI on the Mac's PATH"}
                    className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-blue-500 focus:outline-none"
                  />
                </label>
                {driver === "acp" && (
                  <label className="block text-xs text-muted-foreground">
                    Arguments, one per line
                    <textarea
                      rows={2}
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                )}
                <label className="block text-xs text-muted-foreground">
                  Environment variable names, one per line
                  <textarea
                    rows={2}
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-blue-500 focus:outline-none"
                  />
                  <span className="mt-1 block">Names only: their values are not stored here.</span>
                </label>
              </>
            )}
            {configError && <p className="text-xs text-amber-600 dark:text-amber-400">{configError}</p>}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm text-foreground">On</div>
                <div className="text-xs text-muted-foreground">Off: listed, runs no jobs.</div>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            </div>
          </>
        )}

        <DialogFooter className="gap-2 sm:justify-end">
          {step === 1 ? (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!driver}
                onClick={() => {
                  setManual(true);
                  setStep(2);
                }}
              >
                Configure manually
              </Button>
              <Button
                size="sm"
                className={PRIMARY}
                disabled={!runs}
                onClick={() => {
                  setManual(false);
                  setStep(2);
                }}
              >
                {login && driver && hasProviderLogo(driver) && <ProviderLogo driver={driver} inherit className="h-4 w-4" />}
                {login ? `Continue with ${login.label}` : "Next"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setStep((s) => (s - 1) as 1 | 2)}>
                Back
              </Button>
              {step === 2 ? (
                <Button size="sm" className={PRIMARY} disabled={!label.trim() || !!idError || duplicate} onClick={() => setStep(3)}>
                  Next
                </Button>
              ) : (
                <Button size="sm" className={PRIMARY} disabled={busy || duplicate || !!configError || !label.trim() || !!idError} onClick={() => void add()}>
                  {busy ? "Adding…" : "Add"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function basename(home: string): string {
  return home.trim().replace(/\/+$/, "").split("/").pop() ?? "";
}

/** The id jobs point at: "~/.claude-work" → "claude_work"; no folder → the driver's id. Starts with a letter, unique. */
function instanceId(driver: Driver, home: string, taken: string[]): string {
  let base = home.trim() ? basename(home).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) : "";
  if (base && !/^[a-z]/.test(base)) base = `${driver}_${base}`;
  base = base || driver;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

/** "Claude (work)" for ~/.claude-work; "Codex (default)" with no folder. */
function defaultName(driver: Driver, home: string): string {
  const label = DRIVERS.find((d) => d.id === driver)?.label ?? driver;
  const part = basename(home).replace(/^\./, "").replace(/^(claude|codex|grok|gemini)[-_]?/i, "") || "default";
  return `${label} (${part})`;
}
