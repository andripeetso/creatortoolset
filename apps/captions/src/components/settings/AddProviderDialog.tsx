import { useEffect, useState } from "react";
import { DRIVERS, type Driver, type DriverCatalog, type MacReport, type PresetView, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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
  report,
  driver,
  showMore,
  onPick,
  onPreset,
  onToggleMore,
}: {
  catalog: DriverCatalog | null;
  report: MacReport | null;
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
    const found = report?.drivers.find((x) => x.driver === d.id);
    const runs = !!entry?.runs;
    const note = !runs
      ? (entry?.reason ?? "Checking what this app can run…")
      : !report
        ? "This Mac has not reported yet"
        : found?.installed
          ? `Installed${found.version ? ` · v${found.version}` : ""}`
          : "Not installed";
    return (
      <button
        key={d.id}
        type="button"
        disabled={!runs}
        aria-pressed={driver === d.id}
        onClick={() => onPick(d.id)}
        className={cn(
          "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          driver === d.id ? "border-violet-500 bg-violet-500/10" : "border-border hover:bg-accent",
        )}
      >
        <div className="text-sm text-foreground">{d.label}</div>
        <div className={cn("mt-0.5 text-xs", runs && found?.installed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>{note}</div>
      </button>
    );
  };
  const presetRow = (p: PresetView) => {
    const runs = !!catalog?.drivers.find((d) => d.id === p.driver)?.runs;
    return (
      <button
        key={`preset-${p.id}`}
        type="button"
        disabled={!runs || !onPreset}
        onClick={() => onPreset?.(p)}
        className="col-span-2 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-foreground">{p.name}</span>
          <span className="shrink-0 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-700 dark:text-violet-300">{p.badge}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{DRIVERS.find((d) => d.id === p.driver)?.label ?? p.driver}{p.home ? ` · ${p.home}` : ""}</div>
      </button>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      {(catalog?.presets ?? []).map(presetRow)}
      {all.filter((d) => d.featured).map(tile)}
      <button
        type="button"
        aria-expanded={showMore}
        onClick={onToggleMore}
        className="col-span-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
      >
        {showMore ? "Show less" : "Show more"}
      </button>
      {showMore && all.filter((d) => !d.featured).map(tile)}
    </div>
  );
}

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

  const stepLabel = (n: 1 | 2 | 3, text: string) => (
    <span className={cn("text-xs", step === n ? "text-foreground" : "text-muted-foreground/60")}>
      {n} {text}
    </span>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add your AI</DialogTitle>
          <DialogDescription>Add an account or set up your AI on {deviceName}.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-3">
          {stepLabel(1, "Provider")}
          <span className="text-muted-foreground/40">›</span>
          {stepLabel(2, "Identity")}
          <span className="text-muted-foreground/40">›</span>
          {stepLabel(3, "Config")}
        </div>

        {step === 1 && (
          <>
            <DriverGrid
              catalog={catalog}
              report={report}
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
                className={cn("rounded-lg border px-3 py-2 text-left text-sm", home === "" ? "border-violet-500 bg-violet-500/10" : "border-border hover:bg-accent")}
              >
                Default
              </button>
              {homes.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHome(h)}
                  className={cn("rounded-lg border px-3 py-2 text-left font-mono text-xs", home === h ? "border-violet-500 bg-violet-500/10" : "border-border text-muted-foreground hover:bg-accent")}
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
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-violet-500 focus:outline-none"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Name
              <input
                value={label}
                onChange={(e) => setNameDraft(e.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus:border-violet-500 focus:outline-none"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Provider id (what jobs point at)
              <input
                value={id}
                onChange={(e) => setIdDraft(e.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground focus:border-violet-500 focus:outline-none"
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
                    className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-violet-500 focus:outline-none"
                  />
                </label>
                {driver === "acp" && (
                  <label className="block text-xs text-muted-foreground">
                    Arguments, one per line
                    <textarea
                      rows={2}
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-violet-500 focus:outline-none"
                    />
                  </label>
                )}
                <label className="block text-xs text-muted-foreground">
                  Environment variable names, one per line
                  <textarea
                    rows={2}
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-violet-500 focus:outline-none"
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

        <DialogFooter className="sm:justify-between">
          {step === 1 ? (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <div className="flex flex-wrap justify-end gap-2">
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
                  disabled={!runs}
                  onClick={() => {
                    setManual(false);
                    setStep(2);
                  }}
                >
                  {login ? `Continue with ${login.label}` : "Next"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setStep((s) => (s - 1) as 1 | 2)}>
                Back
              </Button>
              {step === 2 ? (
                <Button size="sm" disabled={!label.trim() || !!idError || duplicate} onClick={() => setStep(3)}>
                  Next
                </Button>
              ) : (
                <Button size="sm" disabled={busy || duplicate || !!configError || !label.trim() || !!idError} onClick={() => void add()}>
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
