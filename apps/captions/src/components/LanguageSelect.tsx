import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { SPOKEN_LANGUAGES, languageName } from "@contracts/voice";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVoice } from "@/lib/voice";
import { cn } from "@/lib/utils";

/**
 * The language spoken in a project's or an edit's videos: one code, or "" for the person's own languages (Settings → AI
 * → Voice; none there = English, as api/transcribe.ts hears it). Saved as `languages: [code]` (none: []). A short
 * list you can type into, so 30 languages never fill the screen.
 */
export function LanguageSelect({ id, value, onChange, disabled, className, placeholder }: {
  id?: string;
  /** The label of "" in place of the person's own languages (a question's "Other…"): every language is then listed. */
  placeholder?: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const mine = useVoice().data?.languages ?? [];
  const usual = placeholder ?? (mine.length ? mine.map(languageName).join(", ") : "English");
  // the default already names a single language: it is not listed twice
  const one = !placeholder && mine.length <= 1 ? (mine[0] ?? "en") : null;
  const rest = SPOKEN_LANGUAGES.filter((c) => c !== one);
  const isDefault = !value || value === one;
  const pick = (code: string) => {
    onChange(code);
    setOpen(false);
  };
  return (
    // modal: inside a window (the Projects one) the window's scroll lock would eat the list's wheel; the popover's own
    // lock lets the list scroll
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button id={id} type="button" role="combobox" aria-expanded={open} className={cn("flex items-center justify-between gap-2 text-left", className)}>
          <span className="truncate">{isDefault ? usual : languageName(value)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 min-w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search languages" />
          <CommandList className="max-h-64">
            <CommandEmpty>No such language</CommandEmpty>
            <CommandItem value={`${usual} default`} onSelect={() => pick("")}>
              <Check className={cn("size-3.5", isDefault ? "" : "opacity-0")} />
              {usual}
              {!placeholder && <span className="ml-auto text-xs text-muted-foreground">default</span>}
            </CommandItem>
            {rest.map((c) => (
              <CommandItem key={c} value={languageName(c)} onSelect={() => pick(c)}>
                <Check className={cn("size-3.5", value === c ? "" : "opacity-0")} />
                {languageName(c)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
