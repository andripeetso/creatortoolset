import { ArrowDown, ArrowUp, Check, ChevronDown } from "lucide-react";
import type { LibrarySort } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Sort, in the Library's toolbar after View (11-19 sign-off C4): what to sort by is one dropdown, which way is its own
 * button beside it. Both write the one stored sort (LibrarySort, the server's order), so a choice made before still loads.
 * Date filmed is the file's own filming date, else when it was added (api/library/query.ts).
 */
export type SortBy = "filmed" | "added" | "name" | "length";
export const SORT_BY: readonly { id: SortBy; label: string }[] = [
  { id: "filmed", label: "Date filmed" },
  { id: "added", label: "Date added" },
  { id: "name", label: "Name" },
  { id: "length", label: "Length" },
];

/** Each key's two orders: [the first way (↓), the other (↑)]. */
const ORDERS: Record<SortBy, [LibrarySort, LibrarySort]> = {
  filmed: ["filmed", "filmed-old"],
  added: ["new", "old"],
  name: ["name", "name-za"],
  length: ["longest", "shortest"],
};
/** The words of each order, the way the button says it. */
const WORDS: Record<SortBy, [string, string]> = {
  filmed: ["Newest first", "Oldest first"],
  added: ["Newest first", "Oldest first"],
  name: ["A → Z", "Z → A"],
  length: ["Longest first", "Shortest first"],
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

export function SortControls({ sort, onSort }: { sort: LibrarySort; onSort: (s: LibrarySort) => void }) {
  const { by, first } = splitSort(sort);
  const now = orderWords(by, first);
  const Arrow = first ? ArrowDown : ArrowUp;
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8" aria-label={`Sort by ${SORT_BY.find((o) => o.id === by)!.label}`}>
            {SORT_BY.find((o) => o.id === by)!.label}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          {SORT_BY.map((o) => (
            // a new key keeps the way it was going (newest first stays the first way)
            <DropdownMenuItem key={o.id} onSelect={() => onSort(sortOf(o.id, first))}>
              <Check className={o.id === by ? "h-4 w-4 text-violet-600" : "h-4 w-4 opacity-0"} />
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" className="h-8 w-8 px-0" aria-label={now} title={`${now} · click for ${orderWords(by, !first)}`} onClick={() => onSort(sortOf(by, !first))}>
        <Arrow className="h-4 w-4" />
      </Button>
    </>
  );
}
