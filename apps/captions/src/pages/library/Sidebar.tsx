import { useState, type ReactNode } from "react";
import { Download, FileX, SlidersHorizontal, X } from "lucide-react";
import { LibraryFacetBar, type FacetChoice } from "@/components/LibraryFacetBar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { listAssets, listPlaces, listTags, type LibraryFilters } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { thisMacDevice } from "@/lib/providers";
import { macPlaces } from "@/lib/thisMac";
import { cn } from "@/lib/utils";
import { anyFilter, countryName, HereFilter, presets, WhenPicker } from "./Filters";
import { Missing } from "./Missing";

/**
 * The Media Library's sidebar (LibraryPage.tsx): When, Where (the countries clips were filmed in, with counts), Orientation, Tags
 * (with counts, every one picked; its own small search), then a plug-in's own groups. On a desktop it stands left
 * of the grid and scrolls by itself; on a narrow window and a phone the Filters button opens it as a sheet.
 */


const ORIENTATIONS = [
  { value: "vertical", label: "Vertical" },
  { value: "horizontal", label: "Horizontal" },
] as const;

export interface SidebarProps {
  libraryId: string;
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
export const sidebarPicked = (p: Pick<SidebarProps, "filters" | "facetValue" | "source">) =>
  anyFilter(p.filters) || Object.values(p.facetValue).some((v) => v.length) || !!p.source;

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
  const places = useCachedLoad(`/api/library/${p.libraryId}/countries`, () => listPlaces(p.libraryId));
  const f = p.filters;
  // Missing on this computer shows only when this computer found clips gone (or while it is on): up to 100 counted, then "100+"
  const missing = useCachedLoad(macPlaces() ? `/api/library/${p.libraryId}/assets?missing=1` : null, () =>
    listAssets(p.libraryId, { missing: true, limit: 100 }),
  );
  const [tagQ, setTagQ] = useState("");
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

      <Section title="Orientation">
        <div className="flex flex-wrap gap-1.5">
          {ORIENTATIONS.map((o) => (
            <Pill key={o.value} on={f.orientation === o.value} onClick={() => set({ orientation: f.orientation === o.value ? undefined : o.value })}>
              {o.label}
            </Pill>
          ))}
        </div>
      </Section>

      {thisMacDevice() && (
        <Section title="Computer">
          <div className="flex flex-wrap gap-1.5">
            <HereFilter value={f} onChange={(here) => set({ here })} />
            <Pill on={!!f.offline} onClick={() => set({ offline: f.offline ? undefined : true })}>
              <Download aria-hidden className="h-3.5 w-3.5" />
              Available offline
            </Pill>
            {macPlaces() && (!!missing.data?.items.length || !!f.missing) && (
              <Pill on={!!f.missing} onClick={() => set({ missing: f.missing ? undefined : true })}>
                <FileX aria-hidden className="h-3.5 w-3.5" />
                Missing on this computer
                {!!missing.data?.items.length && (
                  <span className="tabular-nums text-zinc-500">{missing.data.next ? "100+" : missing.data.items.length.toLocaleString()}</span>
                )}
              </Pill>
            )}
          </div>
          {f.missing && <Missing libraryId={p.libraryId} />}
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
        <Button size="sm" variant="ghost" className="w-fit" onClick={() => clearAll(p)}>
          Clear
        </Button>
      )}
    </div>
  );
}

type Picks = Omit<SidebarProps, "libraryId">;

const clearAll = (p: Picks) => {
  p.onFilters({});
  p.onFacets({});
  p.onSource("");
};

const dayWord = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** When as the sidebar picked it: a preset's name, else the days (filmedTo is the midnight after the last day). */
function whenWord(from?: number, to?: number) {
  const preset = to === undefined && presets().find((x) => x.from === from);
  if (preset) return preset.label;
  if (from !== undefined && to !== undefined) return `${dayWord(from)} – ${dayWord(to - 1)}`;
  return from !== undefined ? `From ${dayWord(from)}` : `To ${dayWord(to! - 1)}`;
}

/**
 * What the sidebar narrows the list to, as one row under the tabs: each pick with its X, then Clear. The sidebar can be
 * scrolled away or folded into a sheet, so without this an empty list would not say why.
 */
export function ActiveFilters(p: Picks) {
  const f = p.filters;
  const set = (patch: Partial<LibraryFilters>) => p.onFilters({ ...f, ...patch });
  const chips: { key: string; label: string; off: () => void }[] = [
    ...(p.source ? [{ key: "source", label: p.sources.find((s) => s.id === p.source)?.label ?? p.source, off: () => p.onSource("") }] : []),
    ...(f.filmedFrom !== undefined || f.filmedTo !== undefined
      ? [{ key: "when", label: whenWord(f.filmedFrom, f.filmedTo), off: () => set({ filmedFrom: undefined, filmedTo: undefined }) }]
      : []),
    ...(f.place ? [{ key: "place", label: countryName(f.place), off: () => set({ place: undefined }) }] : []),
    ...(f.orientation ? [{ key: "orientation", label: ORIENTATIONS.find((o) => o.value === f.orientation)!.label, off: () => set({ orientation: undefined }) }] : []),
    ...(f.here ? [{ key: "here", label: "On this computer", off: () => set({ here: undefined }) }] : []),
    ...(f.offline ? [{ key: "offline", label: "Available offline", off: () => set({ offline: undefined }) }] : []),
    ...(f.missing ? [{ key: "missing", label: "Missing on this computer", off: () => set({ missing: undefined }) }] : []),
    ...(f.tags ?? []).map((t) => ({ key: `tag:${t}`, label: t, off: () => set({ tags: f.tags!.filter((x) => x !== t) }) })),
    ...Object.entries(p.facetValue).flatMap(([k, vs]) =>
      vs.map((v) => ({
        key: `f:${k}:${v}`,
        label: p.facets.find((x) => x.key === k)?.values.find((x) => x.value === v)?.label ?? v,
        off: () => p.onFacets({ ...p.facetValue, [k]: vs.filter((x) => x !== v) }),
      })),
    ),
  ];
  if (!chips.length) return null;
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className="flex h-7 max-w-full items-center gap-1 rounded-full border border-violet-500 bg-violet-500/15 pl-2.5 pr-1 text-[12px] text-zinc-100">
          <span className="truncate">{c.label}</span>
          <button type="button" aria-label={`Remove ${c.label}`} onClick={c.off} className="rounded-full p-0.5 text-zinc-400 hover:text-zinc-100">
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
      <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => clearAll(p)}>
        Clear
      </Button>
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
