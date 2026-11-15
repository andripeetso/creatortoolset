import { useSyncExternalStore } from "react";
import { Folder, LayoutGrid, List } from "lucide-react";
import { pageView } from "@/components/browse/views";

/**
 * The Media Library's three views, kept on this device under its own key: Folders (the folder cards, then the clips),
 * Gallery (only the clips, big and edge to edge) and List (rows). Before a pick here it opens as Settings → Appearance
 * says for the Media Library (cards: Folders, rows: List). The other tools' views (components/browse/views.ts) keep
 * their two.
 */
export type LibraryView = "folders" | "gallery" | "list";
const VIEWS: LibraryView[] = ["folders", "gallery", "list"];
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

const ICONS = { folders: Folder, gallery: LayoutGrid, list: List } as const;
const TITLES = { folders: "Folders", gallery: "Gallery", list: "List" } as const;

/** The three views, side by side. */
export function LibraryViewSwitch({ view, onChange }: { view: LibraryView; onChange: (v: LibraryView) => void }) {
  return (
    <div role="group" aria-label="View" className="flex gap-0.5 rounded-md border border-zinc-800 p-0.5">
      {VIEWS.map((v) => {
        const Icon = ICONS[v];
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            title={TITLES[v]}
            aria-label={TITLES[v]}
            aria-pressed={view === v}
            className={`rounded p-1 transition-colors ${view === v ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
