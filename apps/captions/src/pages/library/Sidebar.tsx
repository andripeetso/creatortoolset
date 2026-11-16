import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { AssetKind, LibrarySort } from "@contracts/library";
import { LibraryFacetBar, type FacetChoice } from "@/components/LibraryFacetBar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { listPlaces, listTags, type LibraryFilters } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { thisMacDevice } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { anyFilter, countryName, HereFilter, WhenPicker } from "./Filters";

/**
 * The Media Library's sidebar (LibraryPage.tsx): Sort, When, Where (the countries clips were filmed in, with counts), Tags
 * (with counts, every one picked; its own small search), Kinds, then a plug-in's own groups. On a desktop it stands left
 * of the grid and scrolls by itself; on a narrow window and a phone the Filters button opens it as a sheet.
 */

export const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "new", label: "Newest" },
  { id: "old", label: "Oldest" },
  { id: "name", label: "Name" },
  { id: "longest", label: "Longest" },
  { id: "shortest", label: "Shortest" },
  { id: "filmed", label: "Date filmed" },
];

export const KINDS: { value: AssetKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "image", label: "Photos" },
  { value: "doc", label: "Documents" },
];

export interface SidebarProps {
  libraryId: string;
  sort: LibrarySort;
  onSort: (s: LibrarySort) => void;
  kind: AssetKind | "all";
  onKind: (k: AssetKind | "all") => void;
  filters: LibraryFilters;
  onFilters: (f: LibraryFilters) => void;
  /** the plug-in sources this library offers, and the one shown ("": the library itself) */
  sources: { id: string; label: string }[];
  source: string;
  onSource: (id: string) => void;
  facets: FacetChoice[];
  facetValue: Record<string, string[]>;
  onFacets: (v: Record<string, string[]>) => void;
}

/** Anything narrowed from the sidebar: its Clear shows. */
export const sidebarPicked = (p: Pick<SidebarProps, "kind" | "filters" | "facetValue" | "source">) =>
  p.kind !== "all" || anyFilter(p.filters) || Object.values(p.facetValue).some((v) => v.length) || !!p.source;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function Pill({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
        on ? "border-violet-500 bg-violet-500/15 text-zinc-100" : "border-zinc-500/30 text-zinc-400 hover:border-zinc-400/60 hover:text-zinc-200",
      )}
    >
      {children}
    </button>
  );
}

const Count = ({ n }: { n: number }) => <span className="tabular-nums text-zinc-500">{n.toLocaleString()}</span>;

export function LibrarySidebar(p: SidebarProps) {
  const tags = useCachedLoad(`/api/library/${p.libraryId}/tags`, () => listTags(p.libraryId));
  const places = useCachedLoad(`/api/library/${p.libraryId}/places`, () => listPlaces(p.libraryId));
  const [tagQ, setTagQ] = useState("");
  const f = p.filters;
  const picked = f.tags ?? [];
  // an emptied pick is no pick: the page's query (and its cached page) stays the one without it
  const set = (patch: Partial<LibraryFilters>) =>
    p.onFilters(Object.fromEntries(Object.entries({ ...f, ...patch }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))));
  const toggleTag = (t: string) => set({ tags: picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t] });
  const needle = tagQ.trim().toLowerCase();
  // the picked ones first, then the most used that fit what is typed
  const tagList = [
    ...picked.map((tag) => tags.data?.find((t) => t.tag === tag) ?? { tag, count: 0 }),
    ...(tags.data ?? []).filter((t) => !picked.includes(t.tag) && t.tag.toLowerCase().includes(needle)).slice(0, 60),
  ];
  const plugin = p.sources.length > 0; // a plug-in's facets narrow its source's items: none where it offers no source

  return (
    <div className="flex flex-col gap-5">
      <Section title="Sort">
        <select
          aria-label="Sort clips"
          value={p.sort}
          onChange={(e) => p.onSort(e.target.value as LibrarySort)}
          className="h-8 rounded-md border border-zinc-500/30 bg-transparent px-2 text-[12px] text-zinc-300 outline-none"
        >
          {SORTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Section>

      <Section title="When">
        <WhenPicker value={f} onChange={(w) => set(w)} />
      </Section>

      {(!!places.data?.length || !!f.place) && (
        <Section title="Where">
          <div className="flex flex-wrap gap-1.5">
            {(places.data ?? []).map((pl) => (
              <Pill key={pl.place} on={f.place === pl.place} onClick={() => set({ place: f.place === pl.place ? undefined : pl.place })}>
                <span className="truncate">{countryName(pl.place)}</span>
                <Count n={pl.count} />
              </Pill>
            ))}
          </div>
        </Section>
      )}

      {thisMacDevice() && (
        <Section title="Computer">
          <HereFilter value={f} onChange={(here) => set({ here })} />
        </Section>
      )}

      {(!!tags.data?.length || picked.length > 0) && (
        <Section title="Tags">
          {(tags.data?.length ?? 0) > 12 && (
            <input
              type="search"
              aria-label="Search tags"
              placeholder="Search tags"
              value={tagQ}
              onChange={(e) => setTagQ(e.target.value)}
              className="h-7 rounded-md border border-zinc-500/30 bg-transparent px-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-500"
            />
          )}
          <div className="flex flex-wrap gap-1.5">
            {tagList.map((t) => (
              <Pill key={t.tag} on={picked.includes(t.tag)} onClick={() => toggleTag(t.tag)}>
                <span className="truncate">{t.tag}</span>
                {t.count > 0 && <Count n={t.count} />}
              </Pill>
            ))}
          </div>
        </Section>
      )}

      <Section title="Kinds">
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <Pill key={k.value} on={p.kind === k.value} onClick={() => p.onKind(k.value)}>
              {k.label}
            </Pill>
          ))}
        </div>
      </Section>

      {plugin && (
        <Section title="Source">
          <div className="flex flex-wrap gap-1.5">
            <Pill on={!p.source} onClick={() => p.onSource("")}>
              Library
            </Pill>
            {p.sources.map((s) => (
              <Pill key={s.id} on={p.source === s.id} onClick={() => p.onSource(s.id)}>
                {s.label}
              </Pill>
            ))}
          </div>
        </Section>
      )}
      {plugin && (
        <div className="flex flex-col gap-3 [&>[role=group]]:flex-wrap">
          <LibraryFacetBar facets={p.facets} value={p.facetValue} onChange={p.onFacets} />
        </div>
      )}

      {sidebarPicked(p) && (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit"
          onClick={() => {
            p.onFilters({});
            p.onKind("all");
            p.onFacets({});
            p.onSource("");
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

/** A narrow window's and a phone's way to the sidebar: a button that opens it as a sheet. */
export function SidebarSheet({ picked, children }: { picked: boolean; children: ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 border-zinc-800 bg-transparent lg:hidden">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {picked && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-violet-500" />}
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 overflow-y-auto p-4 pt-12">
        <SheetTitle className="sr-only">Filters</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
