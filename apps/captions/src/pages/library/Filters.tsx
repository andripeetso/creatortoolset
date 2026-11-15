import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { SearchQuery } from "@contracts/library";
import type { LibraryFilters } from "@/lib/library";
import { cn } from "@/lib/utils";

/**
 * The library's own filters, as the sidebar shows them (./Sidebar.tsx): Tags (every one picked), When (filmed, else
 * added), Where (the country, once a clip has one). The page hands the value to listAssets and searchLibrary, and keeps
 * it in a saved search.
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

let regions: Intl.DisplayNames | null = null;
export const countryName = (code: string) => {
  try {
    return (regions ??= new Intl.DisplayNames(undefined, { type: "region" })).of(code) ?? code;
  } catch {
    return code;
  }
};

export function WhenPicker({ value, onChange }: { value: LibraryFilters; onChange: (w: Pick<LibraryFilters, "filmedFrom" | "filmedTo">) => void }) {
  const [from, setFrom] = useState(value.filmedFrom !== undefined ? iso(value.filmedFrom) : "");
  const [to, setTo] = useState(value.filmedTo !== undefined ? iso(value.filmedTo - 1) : "");
  // a picked day counts whole: up to the next midnight
  const range = (f: string, t: string) => onChange({ filmedFrom: f ? day(f) : undefined, filmedTo: t ? nextDay(day(t)) : undefined });
  // cleared from outside (the sidebar's Clear): the days typed go too
  const none = value.filmedFrom === undefined && value.filmedTo === undefined;
  useEffect(() => {
    if (none) (setFrom(""), setTo(""));
  }, [none]);
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
