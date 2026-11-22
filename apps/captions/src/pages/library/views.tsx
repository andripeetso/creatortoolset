import { useSyncExternalStore, type CSSProperties } from "react";
import { Activity, Check, ChevronDown, Folder, LayoutGrid, List } from "lucide-react";
import { pageView } from "@/components/browse/views";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The Media Library's views, kept on this device under its own key: Folders (the folder cards, then the clips),
 * Gallery (only the clips, big and edge to edge), List (rows) and Status (the library's health, ./Health.tsx). Before a pick here it opens as Settings → Appearance
 * says for the Media Library (cards: Folders, rows: List). The other tools' views (components/browse/views.ts) keep
 * their two.
 */
export type LibraryView = "folders" | "gallery" | "list" | "status";
const VIEWS: LibraryView[] = ["folders", "gallery", "list", "status"];
const KEY = "library:view";
const EVENT = "library-view-change";

export function storedView(): LibraryView {
  try {
    const v = localStorage.getItem(KEY) as LibraryView | null;
    if (v && VIEWS.includes(v)) return v;
  } catch {
    /* storage off: Appearance's choice */
  }
  return pageView("media") === "list" ? "list" : "folders";
}

export function useLibraryView(): [LibraryView, (v: LibraryView) => void] {
  const view = useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    storedView,
    () => "folders" as const,
  );
  const set = (v: LibraryView) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* storage off: the pick holds for this visit */
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return [view, set];
}

const ICONS = { folders: Folder, gallery: LayoutGrid, list: List, status: Activity } as const;
const TITLES = { folders: "Folders", gallery: "Gallery", list: "List", status: "Status" } as const;

/**
 * The View button: one control for how the clips are shown (and Status, the owner's: `status`). Its panel holds the three views as rows and, for the
 * cards, their size. The panel stays open between picks, so a view and a size take one visit.
 */
export function LibraryViewMenu({ view, onChange, size, onSize, status = true }: { view: LibraryView; onChange: (v: LibraryView) => void; size: number | null; onSize: (n: number) => void; status?: boolean }) {
  const Current = ICONS[view];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8" title={`View: ${TITLES[view]}`}>
          <Current className="h-4 w-4" />
          View
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-56 flex-col gap-3 p-2">
        <div role="group" aria-label="Layout" className="flex flex-col">
          {VIEWS.filter((v) => status || v !== "status").map((v) => {
            const Icon = ICONS[v];
            return (
              <button
                key={v}
                type="button"
                onClick={() => onChange(v)}
                aria-label={TITLES[v]}
                aria-pressed={view === v}
                className="flex h-8 items-center gap-2 rounded px-2 text-left text-sm hover:bg-accent"
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{TITLES[v]}</span>
                {view === v && <Check className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
        {view !== "list" && view !== "status" && (
          <label className="flex flex-col gap-1.5 border-t px-2 pt-3 text-xs text-muted-foreground">
            Card size
            <CardSizeSlider size={size} onChange={onSize} />
          </label>
        )}
      </PopoverContent>
    </Popover>
  );
}

const SIZE_KEY = "library:card-size";
const SIZE_EVENT = "library-card-size-change";
// a card's least width in px: the slider's ends and where it starts (today's four across on a wide window)
const SIZE = { min: 120, max: 480, start: 380 } as const;

function storedSize(): number | null {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return n >= SIZE.min && n <= SIZE.max ? n : null;
  } catch {
    return null;
  }
}

/** The cards' size, kept on this device; null until the slider is moved (the grids keep their own columns). */
export function useCardSize(): [number | null, (n: number) => void] {
  const size = useSyncExternalStore(
    (cb) => {
      window.addEventListener(SIZE_EVENT, cb);
      return () => window.removeEventListener(SIZE_EVENT, cb);
    },
    storedSize,
    () => null,
  );
  const set = (n: number) => {
    try {
      localStorage.setItem(SIZE_KEY, String(n));
    } catch {
      /* storage off: the size holds for this visit */
    }
    window.dispatchEvent(new Event(SIZE_EVENT));
  };
  return [size, set];
}

/** Columns as many as fit at `size` px each, never fewer than two. */
export const cardColumns = (size: number): CSSProperties => ({ gridTemplateColumns: `repeat(auto-fill, minmax(min(${size}px, calc(50% - 6px)), 1fr))` });

/** Smaller cards to the left, more of them in a row. */
function CardSizeSlider({ size, onChange }: { size: number | null; onChange: (n: number) => void }) {
  return (
    <input
      type="range"
      aria-label="Card size"
      title="Card size"
      min={SIZE.min}
      max={SIZE.max}
      step={10}
      value={size ?? SIZE.start}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-6 w-full cursor-pointer accent-zinc-400"
    />
  );
}
