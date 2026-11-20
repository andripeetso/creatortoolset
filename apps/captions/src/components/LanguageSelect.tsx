import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { SPOKEN_LANGUAGES, languageName } from "@contracts/voice";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVoice } from "@/lib/voice";
import { cn } from "@/lib/utils";

/**
 * The language spoken in a workspace's or an edit's videos: one code, or "" for the person's own languages (Settings →
 * Voice; none there = English, as api/transcribe.ts hears it), or for `fallback`. Saved as `languages: [code]` (none: []). A short
 * list you can type into, so 30 languages never fill the screen. With `values` it ticks several (a workspace whose videos
 * mix languages): every language is a row that turns on or off and the list stays open. Nothing picked shows the default
 * ticked, and the first pick starts from it (English ticked + Estonian = both); unticking the last goes back to the default.
 */
export function toggleLanguage(values: string[], defaults: string[], code: string): string[] {
  const shown = values.length ? values : defaults;
  return shown.includes(code) ? shown.filter((c) => c !== code) : [...shown, code].slice(0, 5);
}

export function LanguageSelect({ id, value, onChange, values, onValuesChange, disabled, className, placeholder, fallback }: {
  id?: string;
  /** The languages "" stands for when they are not the person's own: an edit's is its workspace's language, when that has one. */
  fallback?: string[];
  /** The label of "" in place of the person's own languages (a question's "Other…"): every language is then listed. */
  placeholder?: string;
  value?: string;
  onChange?: (code: string) => void;
  /** Several languages in place of `value`: the max the server keeps is 5. */
  values?: string[];
  onValuesChange?: (codes: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const own = useVoice().data?.languages ?? [];
  const mine = fallback?.length ? fallback : own;
  const usual = placeholder ?? (mine.length ? mine.map(languageName).join(", ") : "English");
  const many = values !== undefined;
  const defaults = mine.length ? mine : ["en"];
  // the default already names a single language: it is not listed twice (several: every language is its own row)
  const one = !many && !placeholder && mine.length <= 1 ? (mine[0] ?? "en") : null;
  const rest = SPOKEN_LANGUAGES.filter((c) => c !== one);
  const isDefault = many ? !values.length : !value || value === one;
  const ticked = (c: string) => (many ? (values.length ? values : defaults).includes(c) : value === c);
  const pick = (code: string) => {
    if (!many) {
      onChange?.(code);
      setOpen(false);
    } else onValuesChange?.(toggleLanguage(values, defaults, code));
  };
  return (
    // modal: inside a window (the Projects one) the window's scroll lock would eat the list's wheel; the popover's own
    // lock lets the list scroll
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button id={id} type="button" role="combobox" aria-expanded={open} className={cn("flex items-center justify-between gap-2 text-left", className)}>
          <span className="truncate">{isDefault ? usual : many ? values.map(languageName).join(", ") : languageName(value!)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 min-w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search languages" />
          <CommandList className="max-h-64">
            <CommandEmpty>No such language</CommandEmpty>
            {!many && (
              <CommandItem value={`${usual} default`} onSelect={() => pick("")}>
                <Check className={cn("size-3.5", isDefault ? "" : "opacity-0")} />
                {usual}
                {!placeholder && <span className="ml-auto text-xs text-muted-foreground">default</span>}
              </CommandItem>
            )}
            {rest.map((c) => (
              <CommandItem key={c} value={languageName(c)} onSelect={() => pick(c)}>
                <Check className={cn("size-3.5", ticked(c) ? "" : "opacity-0")} />
                {languageName(c)}
                {many && defaults.includes(c) && <span className="ml-auto text-xs text-muted-foreground">default</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
