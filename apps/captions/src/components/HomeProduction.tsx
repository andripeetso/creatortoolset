import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Camera, Clapperboard, GalleryHorizontalEnd, Layers } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionSummaries, type SessionSummary } from "@/lib/workshop-summary";

/**
 * In production, on Home between Plan and Make: the scripts that wait on you away from the app (filming, mostly).
 * Workshop sessions Ready (script done) or In Production. With room it is a stop of its own in the row, dashed because
 * the work is not done here, and it is only there while something waits; without room it is the count over the arrow.
 */

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What waits, from the sessions at a glance. Pure, so it can be tested without a server. */
export function inProduction(rows: SessionSummary[]) {
  const started = rows.filter((r) => r.status === "production");
  const waiting = rows.filter((r) => r.status === "ready");
  const all = started.length + waiting.length;
  // by the kind of each session's first piece
  const of = (kind: string) => [...started, ...waiting].filter((r) => r.kinds[0] === kind).length;
  const reels = of("reel");
  const carousels = of("carousel");
  const other = all - reels - carousels;
  const parts = [reels && plural(reels, "reel"), carousels && plural(carousels, "carousel"), other && `${other} other`].filter(Boolean) as string[];
  return {
    started,
    waiting,
    /** "4 reels", "3 carousels", "2 other" */
    parts,
    /** the stop has two lines, as a tile's name has: a third kind is counted into the second */
    lines: parts.length > 2 ? [parts[0], `${all - reels} more`] : parts,
    /** the hover: how many have not been started and how many have */
    says: [waiting.length && `${waiting.length} waiting for production`, started.length && `${started.length} in production`].filter(Boolean).join(" · "),
  };
}
const NONE = inProduction([]);

/** The answer, live: null until the sessions are known. Drawn only for an account that can read the Workshop. */
function useProduction() {
  const rows = useSessionSummaries();
  return useMemo(() => (rows ? inProduction(rows) : null), [rows]);
}

/** What Home last drew, for this page load: coming Home after a script moved there (or the last one left) plays the
 *  change, and a stop that shuts as you arrive still says what it said. */
let wasOpen: boolean | null = null;
let lastSaid = NONE;

/**
 * Whether the stop is drawn. `want` is null while the answer is not known (the sessions not read yet, the project just
 * switched): what was drawn stays. A change is drawn a moment after the page it happened under, so it is seen to
 * open or shut instead of being there already.
 */
export function useStopOpen(want: boolean | null): boolean {
  const [open, setOpen] = useState(wasOpen ?? want ?? false);
  useEffect(() => {
    wasOpen = open;
    if (want === null || want === open) return;
    const t = setTimeout(() => setOpen(want), 250);
    return () => clearTimeout(t);
  }, [want, open]);
  return open;
}

/** Without room for the stop: the count over the arrow into Make. Opens the Workshop. */
export function ProductionCount() {
  const prod = useProduction();
  if (!prod?.parts.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/workshop"
          className="stop-count intro-late flex flex-col items-center whitespace-nowrap text-center text-[11px] leading-tight text-[var(--tint-text)] transition-[filter] duration-200 hover:brightness-125 hub-narrow:flex-row hub-narrow:gap-1.5"
        >
          {prod.parts.map((p) => <span key={p}>{p}</span>)}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{prod.says}</TooltipContent>
    </Tooltip>
  );
}

// as Finals shows a kind
const KIND_ICON = { reel: Clapperboard, carousel: GalleryHorizontalEnd } as const;

/**
 * The stop itself and the arrow out of it. It is there while something waits, never during the welcome (`shut`), and
 * says so to the row (data-open: index.css opens and shuts it). Hover says how many of each status; a click lists the
 * scripts, each opening its session. While it shuts, what it last said stays.
 */
export function ProductionStop({ shut }: { shut: boolean }) {
  const prod = useProduction();
  const open = useStopOpen(shut ? false : prod ? prod.parts.length > 0 : null);
  const [last, setLast] = useState(lastSaid);
  if (prod?.parts.length && last !== prod) setLast(prod);
  const shown = prod?.parts.length ? prod : last;
  useEffect(() => {
    lastSaid = shown;
  }, [shown]);
  const groups = [["In production", shown.started], ["Waiting", shown.waiting]] as const;
  return (
    <div className="stop-box" data-open={open || undefined} inert={!open}>
      <div className="ml-3 flex w-[136px] shrink-0 flex-col self-stretch rounded-2xl border border-dashed border-[color-mix(in_srgb,var(--tint)_55%,transparent)] p-3">
        <h2 className="whitespace-nowrap px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">In production</h2>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                {/* the hover is for the pointer: focus coming back from the list would leave it standing */}
                <button
                  type="button"
                  aria-label={`In production: ${shown.says}`}
                  onFocus={(e) => e.preventDefault()}
                  className="group mx-auto flex w-[88px] flex-col items-center gap-2 rounded-xl px-1 py-2 text-center hub-2xl:w-[104px]"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--tint)_60%,transparent)] text-[var(--tint-text)] transition-colors duration-200 group-hover:border-[var(--tint)] hub-2xl:h-14 hub-2xl:w-14">
                    <Camera className="h-6 w-6" />
                  </span>
                  <span className="text-xs leading-tight text-[var(--tint-text)]">
                    {shown.lines.map((l) => <span key={l} className="block whitespace-nowrap">{l}</span>)}
                  </span>
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{shown.says}</TooltipContent>
          </Tooltip>
          <PopoverContent className="max-h-96 w-72 overflow-y-auto p-1.5">
            {groups.map(([label, list]) => list.length > 0 && (
              <Fragment key={label}>
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
                {list.map((r) => {
                  const Icon = KIND_ICON[r.kinds[0] as keyof typeof KIND_ICON] ?? Layers;
                  return (
                    <Link key={r.id} to={`/workshop/sessions/${r.id}`} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{r.title || "Untitled session"}</span>
                    </Link>
                  );
                })}
              </Fragment>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      <ArrowRight className="ml-3 h-4 w-4 shrink-0 text-zinc-600" />
    </div>
  );
}
