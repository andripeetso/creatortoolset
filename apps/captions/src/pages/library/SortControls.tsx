import { ArrowDown, ArrowUp, Check, ChevronDown } from "lucide-react";
import type { LibrarySort } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { COL, LIST_COLS } from "./ClipCards";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Sort, in the Library's toolbar after View (11-19 sign-off C4): what to sort by is one dropdown, which way is its own
 * button beside it. Both write the one stored sort (LibrarySort, the server's order), so a choice made before still loads.
 * Date filmed is the file's own filming date, else when it was added (api/library/query.ts).
 */
export type SortBy = "filmed" | "added" | "name" | "length" | "size" | "kind";
export const SORT_BY: readonly { id: SortBy; label: string }[] = [
  { id: "filmed", label: "Date filmed" },
  { id: "added", label: "Date added" },
  { id: "name", label: "Name" },
  { id: "length", label: "Length" },
  { id: "size", label: "Size" },
  { id: "kind", label: "Kind" },
];

/** Each key's two orders: [the first way (↓), the other (↑)]. */
const ORDERS: Record<SortBy, [LibrarySort, LibrarySort]> = {
  filmed: ["filmed", "filmed-old"],
  added: ["new", "old"],
  name: ["name", "name-za"],
  length: ["longest", "shortest"],
  size: ["biggest", "smallest"],
  kind: ["kind", "kind-za"],
};
/** The words of each order, the way the button says it. */
const WORDS: Record<SortBy, [string, string]> = {
  filmed: ["Newest first", "Oldest first"],
  added: ["Newest first", "Oldest first"],
  name: ["A → Z", "Z → A"],
  length: ["Longest first", "Shortest first"],
  size: ["Largest first", "Smallest first"],
  kind: ["A → Z", "Z → A"],
};

/** Every stored value, the default first (Date filmed, newest first). */
export const SORT_IDS: readonly LibrarySort[] = Object.values(ORDERS).flat();

/** A stored sort as its key and way (`first`: the key's first way, ↓). */
export function splitSort(s: LibrarySort): { by: SortBy; first: boolean } {
  for (const [by, pair] of Object.entries(ORDERS) as [SortBy, [LibrarySort, LibrarySort]][]) {
    const i = pair.indexOf(s);
    if (i >= 0) return { by, first: i === 0 };
  }
  return { by: "filmed", first: true };
}
export const sortOf = (by: SortBy, first: boolean): LibrarySort => ORDERS[by][first ? 0 : 1];
export const orderWords = (by: SortBy, first: boolean): string => WORDS[by][first ? 0 : 1];

/**
 * The list view's column headers (11-19, Andri: real columns): a sortable one writes the same stored sort as Sort by,
 * a second click on it turns the order around, so the menu, the order button and the headers always say the same.
 */
export function SortHeader({ by: col, label, sort, onSort, className }: { by?: SortBy; label: string; sort: LibrarySort; onSort: (s: LibrarySort) => void; className?: string }) {
  const { by, first } = splitSort(sort);
  if (!col) return <span className={cn("truncate", className)}>{label}</span>;
  const on = by === col;
  const Arrow = first ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      aria-sort={on ? (first ? "descending" : "ascending") : undefined}
      aria-label={on ? `${label}, ${orderWords(col, first)}` : `Sort by ${label}`}
      onClick={() => onSort(sortOf(col, on ? !first : true))}
      className={cn("flex w-full min-w-0 items-center gap-1 text-left hover:text-foreground", on && "text-foreground", className)}
    >
      <span className="truncate">{label}</span>
      {on && <Arrow aria-hidden className="h-3 w-3 shrink-0" />}
    </button>
  );
}

/** The list view's header row: the columns of ClipCards LIST_COLS, each sortable but Roll (the server has no roll order). */
export function ListHeader({ sort, onSort }: { sort: LibrarySort; onSort: (s: LibrarySort) => void }) {
  const h = { sort, onSort };
  return (
    <div className={cn(LIST_COLS, "px-3 pb-0.5 text-[11px] font-medium text-muted-foreground")}>
      {/* each header in its own grid cell: a column's show-from class is on the cell, never on the button's flex */}
      <SortHeader by="name" label="Name" {...h} />
      <span className={COL.filmed}><SortHeader by="filmed" label="Date filmed" {...h} /></span>
      <span className={COL.added}><SortHeader by="added" label="Date added" {...h} /></span>
      <SortHeader by="length" label="Length" {...h} className="justify-end" />
      <span className={COL.size}><SortHeader by="size" label="Size" {...h} className="justify-end" /></span>
      <span className={COL.kind}><SortHeader by="kind" label="Kind" {...h} /></span>
      <span className={COL.roll}><SortHeader label="Roll" {...h} /></span>
    </div>
  );
}

export function SortControls({ sort, onSort }: { sort: LibrarySort; onSort: (s: LibrarySort) => void }) {
  const { by, first } = splitSort(sort);
  return <SortPick by={by} first={first} options={SORT_BY} words={orderWords} onSort={(b, f) => onSort(sortOf(b, f))} />;
}

/** Sort by (a menu) and which way (the arrow beside it): the Media Library's, and any list that sorts the same way (Finals). */
export function SortPick<B extends string>({
  by,
  first,
  options,
  words,
  onSort,
}: {
  by: B;
  /** the key's first way (↓: newest, A → Z) */
  first: boolean;
  options: readonly { id: B; label: string }[];
  words: (by: B, first: boolean) => string;
  onSort: (by: B, first: boolean) => void;
}) {
  const now = words(by, first);
  const Arrow = first ? ArrowDown : ArrowUp;
  const label = options.find((o) => o.id === by)?.label ?? options[0].label;
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8" aria-label={`Sort by ${label}`}>
            {label}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          {options.map((o) => (
            // a new key keeps the way it was going (newest first stays the first way)
            <DropdownMenuItem key={o.id} onSelect={() => onSort(o.id, first)}>
              <Check className={o.id === by ? "h-4 w-4 text-violet-600" : "h-4 w-4 opacity-0"} />
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" className="h-8 w-8 px-0" aria-label={now} title={`${now} · click for ${words(by, !first)}`} onClick={() => onSort(by, !first)}>
        <Arrow className="h-4 w-4" />
      </Button>
    </>
  );
}
