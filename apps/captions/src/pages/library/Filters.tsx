import { useState } from "react";
import { Check, X } from "lucide-react";
import type { SearchQuery } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { listPlaces, listTags, type LibraryFilters } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";

/**
 * The library's own filters on the row under the bar: Tags (every one picked), When (filmed, else added), Where (the
 * country, once a clip has one). The buttons
 * stay first and still; what is picked follows as chips that remove themselves, then one Clear. The page hands the
 * value to listAssets and searchLibrary, and keeps it in a saved search.
 */

export const anyFilter = (f: LibraryFilters) => !!f.tags?.length || f.filmedFrom !== undefined || f.filmedTo !== undefined || !!f.place;

/** A saved search's own filters, with the ones picked now in their place (as the server merges a smart folder's). */
export const withSaved = (f: LibraryFilters, saved?: SearchQuery): LibraryFilters => ({
  tags: f.tags?.length ? f.tags : saved?.tags,
  filmedFrom: f.filmedFrom ?? saved?.filmedFrom,
  filmedTo: f.filmedTo ?? saved?.filmedTo,
  place: f.place ?? saved?.place,
});

const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
};
const iso = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const nextDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/** This week (from Monday), this month, this year: each from its first day on. */
function presets(now = new Date()) {
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  return [
    { label: "This week", from: new Date(y, m, d - ((now.getDay() + 6) % 7)).getTime() },
    { label: "This month", from: new Date(y, m, 1).getTime() },
    { label: "This year", from: new Date(y, 0, 1).getTime() },
  ];
}

function whenLabel(f: LibraryFilters): string {
  const preset = f.filmedTo === undefined && presets().find((p) => p.from === f.filmedFrom);
  if (preset) return preset.label;
  const fmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  const last = f.filmedTo !== undefined ? f.filmedTo - 1 : undefined;
  if (f.filmedFrom !== undefined && last !== undefined) return fmt.formatRange(f.filmedFrom, Math.max(f.filmedFrom, last));
  return f.filmedFrom !== undefined ? `From ${fmt.format(f.filmedFrom)}` : `Until ${fmt.format(last!)}`;
}

let regions: Intl.DisplayNames | null = null;
const countryName = (code: string) => {
  try {
    return (regions ??= new Intl.DisplayNames(undefined, { type: "region" })).of(code) ?? code;
  } catch {
    return code;
  }
};

const chip = "h-8 gap-1 px-2.5 text-[12px]";

export function LibraryFilterRow({
  libraryId,
  value,
  onChange,
  any,
}: {
  libraryId: string;
  value: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  /** the library holds clips: When shows (Tags once a clip has one) */
  any: boolean;
}) {
  const tags = useCachedLoad(`/api/library/${libraryId}/tags`, () => listTags(libraryId));
  const places = useCachedLoad(`/api/library/${libraryId}/places`, () => listPlaces(libraryId));
  const picked = value.tags ?? [];
  const set = (patch: Partial<LibraryFilters>) => onChange({ ...value, ...patch });
  const when = value.filmedFrom !== undefined || value.filmedTo !== undefined;
  if (!any && !anyFilter(value)) return null;
  const toggleTag = (t: string) => set({ tags: picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t] });

  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-1.5">
      {(!!tags.data?.length || picked.length > 0) && (
        <FilterButton label="Tags">
          <Command>
            <CommandInput placeholder="Search tags" />
            <CommandList className="max-h-64">
              <CommandEmpty>No such tag</CommandEmpty>
              {(tags.data ?? []).map((t) => (
                <CommandItem key={t.tag} value={t.tag} onSelect={() => toggleTag(t.tag)}>
                  <Check className={cn("size-3.5", !picked.includes(t.tag) && "opacity-0")} />
                  <span className="flex-1 truncate">{t.tag}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{t.count}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </FilterButton>
      )}
      <FilterButton label="When">
        <WhenPicker value={value} onChange={(w) => set(w)} />
      </FilterButton>
      {(!!places.data?.length || !!value.place) && (
        <FilterButton label="Where">
          <Command>
            {(places.data?.length ?? 0) > 8 && <CommandInput placeholder="Search countries" />}
            <CommandList className="max-h-64">
              <CommandEmpty>No such country</CommandEmpty>
              {(places.data ?? []).map((p) => (
                <CommandItem key={p.place} value={countryName(p.place)} onSelect={() => set({ place: value.place === p.place ? undefined : p.place })}>
                  <Check className={cn("size-3.5", value.place !== p.place && "opacity-0")} />
                  <span className="flex-1 truncate">{countryName(p.place)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{p.count}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </FilterButton>
      )}
      {picked.map((t) => (
        <Button key={t} size="sm" variant="secondary" className={chip} aria-label={`Remove ${t}`} onClick={() => toggleTag(t)}>
          {t}
          <X className="size-3" />
        </Button>
      ))}
      {when && (
        <Button size="sm" variant="secondary" className={chip} aria-label="Remove when" onClick={() => set({ filmedFrom: undefined, filmedTo: undefined })}>
          {whenLabel(value)}
          <X className="size-3" />
        </Button>
      )}
      {value.place && (
        <Button size="sm" variant="secondary" className={chip} aria-label={`Remove ${countryName(value.place)}`} onClick={() => set({ place: undefined })}>
          {countryName(value.place)}
          <X className="size-3" />
        </Button>
      )}
      {anyFilter(value) && (
        <Button size="sm" variant="ghost" className={chip} onClick={() => onChange({})}>
          Clear
        </Button>
      )}
    </div>
  );
}

function FilterButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)] p-0">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function WhenPicker({ value, onChange }: { value: LibraryFilters; onChange: (w: Pick<LibraryFilters, "filmedFrom" | "filmedTo">) => void }) {
  const [from, setFrom] = useState(value.filmedFrom !== undefined ? iso(value.filmedFrom) : "");
  const [to, setTo] = useState(value.filmedTo !== undefined ? iso(value.filmedTo - 1) : "");
  // a picked day counts whole: up to the next midnight
  const range = (f: string, t: string) => onChange({ filmedFrom: f ? day(f) : undefined, filmedTo: t ? nextDay(day(t)) : undefined });
  return (
    <div className="flex flex-col gap-1 p-1">
      {presets().map((p) => {
        const on = value.filmedTo === undefined && value.filmedFrom === p.from;
        return (
          <button
            key={p.label}
            type="button"
            aria-pressed={on}
            onClick={() => (setFrom(""), setTo(""), onChange({ filmedFrom: p.from, filmedTo: undefined }))}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Check className={cn("size-3.5", !on && "opacity-0")} />
            {p.label}
          </button>
        );
      })}
      <div className="grid grid-cols-2 gap-1.5 border-t p-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => (setFrom(e.target.value), range(e.target.value, to))}
            className="h-8 rounded-md border bg-transparent px-1.5 text-[12px] text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => (setTo(e.target.value), range(from, e.target.value))}
            className="h-8 rounded-md border bg-transparent px-1.5 text-[12px] text-foreground"
          />
        </label>
      </div>
    </div>
  );
}
