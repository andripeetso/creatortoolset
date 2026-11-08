import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { DRIVERS, EFFORTS, type ProviderInstance, type ProvidersView, type Selection } from "@contracts/providers";
import { activeSet, effortLabel, getProviders, modelName, modelsOf, selectionLabel } from "@/lib/providers";

/**
 * The composer's model chip (for example "Claude Opus 5.5 · High"). It shows this session's pick or the default
 * of the set that answers this account (its own, or the workspace's), and opens a menu: Use default, the
 * models of each provider, and the effort. Hidden when no provider answers.
 */
export function ModelChip({ ai, onChange }: { ai?: Selection; onChange: (ai: Selection | null) => void }) {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    getProviders().then(setView).catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const active = view ? activeSet(view) : null;
  if (failed || !view || !active || active.settings.instances.length === 0) return null;
  const { settings } = active;
  const shown = ai ?? settings.default;
  const instances = settings.instances.filter((i) => i.enabled);
  const modelList = (inst: ProviderInstance) => modelsOf(view, inst);
  const driverLabel = (inst: ProviderInstance) => DRIVERS.find((d) => d.id === inst.driver)?.label ?? inst.driver;

  const chip = "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]";
  const chipIdle = `${chip} border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground`;
  const item = "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted";

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={chipIdle}
        aria-expanded={open}
        title="Which AI answers this session: its own AI, model and effort. Default is set in Settings → Your AI."
      >
        {ai ? selectionLabel(ai) : `Default: ${selectionLabel(settings.default)}`}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <span className="absolute bottom-full left-0 z-30 mb-1 flex w-72 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl">
          <button type="button" onClick={() => { onChange(null); setOpen(false); }} className={item}>
            <span>Use default</span>
            <span className="text-[10px] text-muted-foreground">{selectionLabel(settings.default)}</span>
            {!ai && <Check className="h-3 w-3" />}
          </button>
          {instances.map((inst) => {
            const list = modelList(inst);
            if (!list.length) return null;
            return (
              <span key={inst.id} className="mt-1 flex flex-col">
                <span className="px-2 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {inst.name}
                  {driverLabel(inst) !== inst.name ? ` · ${driverLabel(inst)}` : ""}
                </span>
                {list.map((m) => {
                  const on = ai?.instance === inst.id && ai.model === m;
                  return (
                    <button key={m} type="button" onClick={() => onChange({ instance: inst.id, model: m, effort: shown.effort })} className={item}>
                      <span>{modelName(m)}</span>
                      {on && <Check className="h-3 w-3" />}
                    </button>
                  );
                })}
              </span>
            );
          })}
          <span className="mt-1 flex flex-wrap gap-1 border-t border-border px-1 pt-1.5">
            <span className="w-full text-[10px] uppercase tracking-wider text-muted-foreground">Effort</span>
            {EFFORTS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onChange({ ...shown, effort: e })}
                aria-pressed={shown.effort === e}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${shown.effort === e ? "border-foreground/30 bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
              >
                {effortLabel(e)}
              </button>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
