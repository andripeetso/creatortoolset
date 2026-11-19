import { useEffect, useState } from "react";
import type { SearchQuery } from "@contracts/library";
import { Laptop } from "lucide-react";
import type { LibraryFilters } from "@/lib/library";
import { thisMacDevice } from "@/lib/providers";
import { cn } from "@/lib/utils";

/**
 * The library's own filters, as the sidebar shows them (./Sidebar.tsx): Tags (every one picked), When (filmed, else
 * added), Where (the country, once a clip has one), On this computer and Missing on this computer (the Mac app). The page hands the value to listAssets and searchLibrary, and keeps
 * it in a saved search.
 */

/** A saved search keeps its filters but never Available offline: that names this person's list, not the search. */
export const savable = ({ offline: _offline, ...f }: LibraryFilters): LibraryFilters => f;

export const anyFilter =(f: LibraryFilters) => !!f.tags?.length || f.filmedFrom !== undefined || f.filmedTo !== undefined || !!f.place || !!f.here || !!f.missing || !!f.offline;

/** A saved search's own filters, with the ones picked now in their place (as the server merges a smart folder's). On this computer and Missing on this computer are never saved: they name one computer. */
export const withSaved = (f: LibraryFilters, saved?: SearchQuery): LibraryFilters => ({
  tags: f.tags?.length ? f.tags : saved?.tags,
  filmedFrom: f.filmedFrom ?? saved?.filmedFrom,
  filmedTo: f.filmedTo ?? saved?.filmedTo,
  place: f.place ?? saved?.place,
  ...(f.here ? { here: true as const } : {}),
  ...(f.missing ? { missing: true as const } : {}),
});

/**
 * On this computer: only the clips whose proxy or file is on the computer this window runs on (the Mac app; a browser
 * has no computer of its own, so it shows nothing). A second click lets go of it.
 */
export function HereFilter({ value, onChange }: { value: LibraryFilters; onChange: (here: LibraryFilters["here"]) => void }) {
  if (!thisMacDevice()) return null;
  return (
    <button
      type="button"
      aria-pressed={!!value.here}
      onClick={() => onChange(value.here ? undefined : true)}
      className={cn(
        "flex h-7 w-fit items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
        value.here ? "border-violet-500 bg-violet-500/15 text-zinc-100" : "border-zinc-500/30 text-zinc-400 hover:border-zinc-400/60 hover:text-zinc-200",
      )}
    >
      <Laptop aria-hidden className="h-3.5 w-3.5" />
      On this computer
    </button>
  );
}

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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {presets().map((p) => {
          const on = value.filmedTo === undefined && value.filmedFrom === p.from;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={on}
              // a second click on the one picked lets go of it
              onClick={() => (setFrom(""), setTo(""), onChange({ filmedFrom: on ? undefined : p.from, filmedTo: undefined }))}
              className={cn(
                "flex h-7 items-center rounded-full border px-2.5 text-[12px] transition-colors",
                on ? "border-violet-500 bg-violet-500/15 text-zinc-100" : "border-zinc-500/30 text-zinc-400 hover:border-zinc-400/60 hover:text-zinc-200",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
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
