import { useState } from "react";
import { DRIVERS, type Driver, type MacReport, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Settings → AI providers → Add provider: three steps (Provider, Identity, Config) on the device the page
 * shows. The Mac's report lists what is installed and its config folders.
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
  const [home, setHome] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  const info = DRIVERS.find((d) => d.id === driver);
  const homes = driver ? (report?.homes ?? []).filter((h) => h.driver === driver).map((h) => h.home) : [];
  const duplicate = !!driver && instances.some((i) => i.driver === driver && (i.home ?? "") === home.trim());
  const id = driver ? instanceId(driver, home, instances.map((i) => i.id)) : "";

  const add = async (inst: ProviderInstance) => {
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
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>It runs on {deviceName}.</DialogDescription>
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
            <div className="grid grid-cols-2 gap-2">
              {DRIVERS.map((d) => {
                const found = report?.drivers.find((x) => x.driver === d.id);
                const note = !d.runs
                  ? "Not supported yet"
                  : !report
                    ? "This Mac has not reported yet"
                    : found?.installed
                      ? `Installed${found.version ? ` · v${found.version}` : ""}`
                      : "Not installed on the Mac";
                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={!d.runs}
                    onClick={() => setDriver(d.id)}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      driver === d.id ? "border-violet-500 bg-violet-500/10" : "border-border hover:bg-accent",
                    )}
                  >
                    <div className="text-sm text-foreground">{d.label}</div>
                    <div className={cn("mt-0.5 text-xs", d.runs && found?.installed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>{note}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 2 && info && (
          <>
            <p className="text-sm text-muted-foreground">Which account does {info.label} use? Each folder on the Mac is one account.</p>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setHome("")}
                className={cn("rounded-lg border px-3 py-2 text-left text-sm", home === "" ? "border-violet-500 bg-violet-500/10" : "border-border hover:bg-accent")}
              >
                Default folder <span className="text-muted-foreground">· the tool's own</span>
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
              Or type a folder
              <input
                value={home}
                onChange={(e) => setHome(e.target.value)}
                placeholder="/Users/you/.claude-work"
                className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-violet-500 focus:outline-none"
              />
            </label>
          </>
        )}

        {step === 3 && info && (
          <>
            <label className="block text-xs text-muted-foreground">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus:border-violet-500 focus:outline-none"
              />
            </label>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm text-foreground">On</div>
                <div className="text-xs text-muted-foreground">Off keeps it listed but out of every job.</div>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {info.label} · {home.trim() || "default folder"}
            </p>
            {duplicate && <p className="text-xs text-amber-600 dark:text-amber-400">That account is already added.</p>}
          </>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => (step === 1 ? onClose() : setStep((s) => (s - 1) as 1 | 2))}>
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step === 1 && (
            <Button size="sm" disabled={!info} onClick={() => setStep(2)}>
              Next
            </Button>
          )}
          {step === 2 && (
            <Button
              size="sm"
              onClick={() => {
                setName(defaultName(driver!, home));
                setStep(3);
              }}
            >
              Next
            </Button>
          )}
          {step === 3 && (
            <Button
              size="sm"
              disabled={busy || duplicate || !name.trim()}
              onClick={() => void add({ id, driver: driver!, name: name.trim(), enabled, ...(home.trim() ? { home: home.trim() } : {}) })}
            >
              {busy ? "Adding…" : "Add provider"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function basename(home: string): string {
  return home.trim().replace(/\/+$/, "").split("/").pop() ?? "";
}

/** The id jobs point at: "~/.claude-work" → "claude_work"; no folder → the driver's id. Unique. */
function instanceId(driver: Driver, home: string, taken: string[]): string {
  const base = home.trim() ? basename(home).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") : driver;
  let id = base || driver;
  for (let n = 2; taken.includes(id); n++) id = `${base || driver}_${n}`;
  return id;
}

/** "Claude (work)" for ~/.claude-work; "Codex (default)" with no folder. */
function defaultName(driver: Driver, home: string): string {
  const label = DRIVERS.find((d) => d.id === driver)?.label ?? driver;
  const part = basename(home).replace(/^\./, "").replace(/^(claude|codex|grok|gemini)[-_]?/i, "") || "default";
  return `${label} (${part})`;
}
