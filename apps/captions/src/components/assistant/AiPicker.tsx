import { useState } from "react";
import { Check } from "lucide-react";
import { EFFORTS, type Selection } from "@contracts/providers";
import { activeSet, effectiveSelection, effortLabel, modelChoices, modelName, modelsOf, shortSelectionLabel, useProviders } from "@/lib/providers";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * The message box's AI button, in both chats: which of the person's AIs answers this chat (or Workshop session), with
 * its model and reasoning level. `ai` is its own pick, `fallback` what answers one with none (their default; the
 * default of the AIs that answer them when not given). Picking sets it here; Default goes back to theirs. Nothing
 * shows until their AIs are known.
 */
export function AiPicker({ ai, fallback: given, onChange }: { ai?: Selection; fallback?: Selection; onChange: (ai: Selection | null) => void }) {
  const [open, setOpen] = useState(false);
  const view = useProviders().data;
  const set = view && activeSet(view);
  const fallback = given ?? set?.settings.default;
  const shown = ai ?? fallback;
  if (!view || !set || !shown) return null;
  // the AIs a computer can run for this account (the server refuses any other)
  const instances = set.settings.instances.filter((i) => i.enabled && i.device);
  const nameOf = (id: string) => set.settings.instances.find((i) => i.id === id)?.name ?? "AI";
  const driverOf = (id: string) => set.settings.instances.find((i) => i.id === id)?.driver ?? "";
  const label = shortSelectionLabel(shown, nameOf(shown.instance));
  const pick = (next: Selection | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 min-w-0 max-w-36 shrink items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`AI for this chat: ${label}${ai ? "" : " (default)"}`}
          title={ai ? `This chat's AI: ${nameOf(shown.instance)}, ${label}` : `Your default AI: ${nameOf(shown.instance)}, ${label}`}
        >
          <ProviderLogo driver={driverOf(shown.instance)} inherit className="size-3.5 opacity-80" />
          {/* the default says so in its hover text and list, not on the button: it stays short */}
          <span className={cn("truncate", !ai && "opacity-70")}>{label}</span>
        </button>
      </PopoverTrigger>
      {/* over the floating dock (z-[55]) */}
      {/* a press in it stays in it: the dock's click-away (it is portalled out of the dock) doesn't close the dock */}
      <PopoverContent side="top" align="end" onPointerDown={(e) => e.stopPropagation()} className="z-[60] flex w-[26rem] max-w-[calc(100vw-2rem)] p-0">
        <Command className="min-w-0 flex-1 rounded-r-none">
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No model by that name</CommandEmpty>
            {fallback && (
              <CommandGroup>
                <CommandItem value="default" onSelect={() => pick(null)}>
                  <span className="flex-1">Default</span>
                  <span className="truncate text-xs text-muted-foreground">{shortSelectionLabel(fallback, nameOf(fallback.instance))}</span>
                  <Check className={cn("size-3.5", ai && "invisible")} />
                </CommandItem>
              </CommandGroup>
            )}
            {instances.map((inst) => {
              const own = effectiveSelection(set.settings, inst, modelsOf(view, inst));
              const models = modelChoices(modelsOf(view, inst), own.model);
              return (
                <CommandGroup key={inst.id} heading={inst.name}>
                  {(models.length ? models : [""]).map((m) => (
                    <CommandItem key={m} value={`${inst.id} ${inst.name} ${m ? modelName(m) : "default model"}`} onSelect={() => pick({ instance: inst.id, model: m, effort: shown.effort })}>
                      <ProviderLogo driver={inst.driver} className="size-3.5" />
                      <span className="flex-1 truncate">{m ? modelName(m) : "Its own default model"}</span>
                      <Check className={cn("size-3.5", !(ai?.instance === inst.id && ai.model === m) && "invisible")} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
        <div className="flex w-36 shrink-0 flex-col border-l p-1">
          <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Reasoning</p>
          {EFFORTS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => pick({ ...shown, effort: e })}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span className="flex-1">
                {effortLabel(e)}
                {fallback?.effort === e && <span className="ml-1.5 text-xs text-muted-foreground">Default</span>}
              </span>
              <Check className={cn("size-3.5", shown.effort !== e && "invisible")} />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
