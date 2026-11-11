import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { isPickClick } from "./browse";

/**
 * The list view: rows under headings. A section with a `label` gets a heading; with `fold` the heading opens and
 * closes it (the tool remembers which). An empty section shows nothing. The tool draws each row (`ListRow` with
 * `RowLink` inside, or a `FolderRow`); picking several rows stays the tool's.
 */
export interface ListSection<T> {
  key: string;
  label?: string;
  items: T[];
  fold?: { open: boolean; onToggle: () => void };
  /** Its rows' box when folded open ("opacity-75" for what is wrapped up). */
  className?: string;
}

export function BrowseList<T>({ sections, row }: { sections: ListSection<T>[]; row: (item: T) => ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {sections.map((s) =>
        s.items.length === 0 ? null : s.fold ? (
          <Fragment key={s.key}>
            <button
              type="button"
              onClick={s.fold.onToggle}
              aria-expanded={s.fold.open}
              className="mt-3 flex items-center gap-3 rounded-md px-1 py-1 text-[12px] text-zinc-500 hover:text-zinc-300"
            >
              <span>
                {s.label} ({s.items.length})
              </span>
              <span className="h-px flex-1 bg-zinc-800" />
              <ChevronDown className={`h-3.5 w-3.5 ${s.fold.open ? "rotate-180" : ""}`} />
            </button>
            {s.fold.open && <div className={`flex flex-col gap-1.5 ${s.className ?? ""}`}>{s.items.map(row)}</div>}
          </Fragment>
        ) : (
          <Fragment key={s.key}>
            {s.label && (
              <p className="px-1 pb-1 text-[12px] text-zinc-500">
                {s.label} ({s.items.length})
              </p>
            )}
            {s.items.map(row)}
          </Fragment>
        ),
      )}
    </div>
  );
}

/**
 * One row. A Shift/⌘-click anywhere on it but its buttons is `onPick`; right-click is `onMenu`; nothing on it
 * selects as text. `data-keep-picked`: a click on a row never clears the tool's picks.
 */
export function ListRow({
  picked,
  onPick,
  onMenu,
  children,
}: {
  picked?: boolean;
  onPick?: (e: React.MouseEvent) => void;
  onMenu?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div
      data-keep-picked
      className={`group flex select-none items-center gap-3 rounded-lg border px-3 py-2.5 ${picked ? "border-violet-500/50 bg-violet-500/5" : "border-zinc-800 bg-zinc-900/50"}`}
      onMouseDown={(e) => isPickClick(e) && e.preventDefault()}
      onClick={(e) => {
        if ((e.target as Element).closest("button, select, input, a[target=_blank], [role=button], [role=combobox]")) return;
        if (isPickClick(e)) onPick?.(e);
      }}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onMenu(e);
        })
      }
    >
      {children}
    </div>
  );
}

/** The row's main link: it fills the row's height and left edge, so a plain click on the row's padding opens it too. */
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      onClick={(e) => isPickClick(e) && e.preventDefault()} // a pick, not a visit: the row picks it
      className="-my-2.5 -ml-3 flex min-w-0 flex-1 items-center gap-2.5 self-stretch py-2.5 pl-3"
    >
      {children}
    </Link>
  );
}
