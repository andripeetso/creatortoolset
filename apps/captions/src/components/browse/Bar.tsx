import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { FolderPlus, LayoutGrid, List, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The row above every list and folders view: search, the type chips, sort and the list / cards switch on the left,
 * the tool's own buttons (`children`) on the right. Everything is controlled: the tool filters and sorts (in the page,
 * or on its server for a big library). New folder and Trash go in the window's top bar (`NewFolderButton`,
 * `TrashLink`), where Review and Finals have them.
 */

export type BrowseView = "grid" | "list";

export interface Chip<K extends string> {
  id: K;
  label: string;
  count?: number;
  /** A colour dot before the label (a type's colour class). */
  dot?: string;
}

export function BrowseBar<K extends string, S extends string>({
  search,
  chips,
  sort,
  view,
  children,
}: {
  search?: { value: string; onChange: (v: string) => void; placeholder: string; /** ⌘K / Ctrl-K focuses it (default on). */ hotkey?: boolean };
  chips?: { value: K; onChange: (k: K) => void; options: Chip<K>[] };
  sort?: { value: S; onChange: (s: S) => void; options: { id: S; label: string }[]; label: string };
  view?: { value: BrowseView; onChange: (v: BrowseView) => void };
  /** Right side: the tool's own buttons (New session, what to do with the picked rows). */
  children?: React.ReactNode;
}) {
  return (
    // one row, one height
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {search && <SearchBox {...search} />}
      <div className="mr-auto flex flex-wrap items-center gap-1.5">
        {chips?.options.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => chips.onChange(c.id)}
            aria-pressed={chips.value === c.id}
            className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] ${chips.value === c.id ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}
          >
            {c.dot ? <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} /> : null}
            {c.label}
            {c.count !== undefined && <> · {c.count}</>}
          </button>
        ))}
        {sort && (
          <select
            value={sort.value}
            onChange={(e) => sort.onChange(e.target.value as S)}
            className="h-8 rounded-md border border-zinc-800 bg-transparent px-2 text-[12px] text-zinc-400 outline-none hover:text-zinc-200"
            aria-label={sort.label}
          >
            {sort.options.map((o) => (
              <option key={o.id} value={o.id}>
                Sort: {o.label}
              </option>
            ))}
          </select>
        )}
        {view && <ViewSwitch view={view.value} onChange={view.onChange} />}
      </div>
      {children}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder, hotkey = true }: { value: string; onChange: (v: string) => void; placeholder: string; hotkey?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);
  return (
    <label className="flex h-8 w-56 items-center gap-1.5 rounded-md border border-zinc-800 px-2 text-[12px] text-zinc-400 focus-within:border-zinc-600">
      <Search className="h-3.5 w-3.5 shrink-0" />
      <input
        ref={input}
        role="searchbox"
        aria-label="Search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
      />
    </label>
  );
}

/** Cards or rows. */
export function ViewSwitch({ view, onChange }: { view: BrowseView; onChange: (v: BrowseView) => void }) {
  const btn = (v: BrowseView, Icon: typeof LayoutGrid, title: string) => (
    <button
      onClick={() => onChange(v)}
      title={title}
      className={`rounded p-1 transition-colors ${view === v ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div className="flex gap-0.5 rounded-md border border-zinc-800 p-0.5">
      {btn("grid", LayoutGrid, "Thumbnail view")}
      {btn("list", List, "List view")}
    </div>
  );
}

/** The top bar's Trash: an icon to the tool's trash. */
export function TrashLink({ to, title }: { to: string; title: string }) {
  return (
    <Link to={to} title={title} aria-label="Trash" className="rounded-md p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
      <Trash2 className="h-4 w-4" />
    </Link>
  );
}

/** The top bar's New folder (its words on a phone: the icon only). */
export function NewFolderButton({ onClick, label = "New folder", className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} className={cn("border-zinc-800 bg-transparent", className)}>
      <FolderPlus /> <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
