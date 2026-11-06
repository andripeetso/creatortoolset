import { Loader2, Search } from "lucide-react";
import { KIND_FILTERS, type PostKind } from "@/lib/instagram";

/** recent = when the post entered the library; newest/oldest = when it was posted. */
export type BrowseOrder = "recent" | "newest" | "oldest";

/** Topic search over the library with reel / carousel / post chips. */
export function SourceSearch({
  query,
  onQuery,
  kind,
  onKind,
  counts,
  searching,
  mine,
  format,
  elsewhere,
  order,
}: {
  query: string;
  onQuery: (q: string) => void;
  kind: PostKind | "";
  onKind: (k: PostKind | "") => void;
  counts: Record<PostKind, number> | null;
  searching: boolean;
  mine?: { on: boolean; label: string; onToggle: () => void } | null;
  /** Only posts kept for their format (layout references). */
  format?: { on: boolean; onToggle: () => void };
  /** Also show posts already used in other sessions (off: hidden). */
  elsewhere?: { on: boolean; count: number; onToggle: () => void };
  /** The library's order (a search keeps its best-match order). */
  order?: { value: BrowseOrder; onChange: (v: BrowseOrder) => void };
}) {
  const total = counts ? counts.reel + counts.carousel + counts.post : 0;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-violet-500">
        {searching ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-400" />
        ) : (
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Narrow the library by topic, or paste an Instagram or YouTube link to add it"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => onKind("")}
          className={`rounded-md border px-2 py-1 ${kind === "" ? "border-violet-500/50 bg-violet-600/15 text-violet-950 dark:text-violet-100" : "border-border text-muted-foreground hover:text-foreground"}`}
        >
          All{counts ? ` · ${total}` : ""}
        </button>
        {KIND_FILTERS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => onKind(k.id)}
            className={`rounded-md border px-2 py-1 ${kind === k.id ? "border-violet-500/50 bg-violet-600/15 text-violet-950 dark:text-violet-100" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {k.label}
            {counts ? ` · ${counts[k.id]}` : ""}
          </button>
        ))}
        {mine ? (
          <button
            type="button"
            onClick={mine.onToggle}
            className={`rounded-md border px-2 py-1 ${mine.on ? "border-violet-500/50 bg-violet-600/15 text-violet-950 dark:text-violet-100" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {mine.label}
          </button>
        ) : null}
        {format ? (
          <button
            type="button"
            aria-pressed={format.on}
            onClick={format.onToggle}
            title="Only posts kept for their format: the layout to copy, not the topic"
            className={`rounded-md border px-2 py-1 ${format.on ? "border-sky-500/50 bg-sky-500/15 text-sky-950 dark:text-sky-100" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            Format
          </button>
        ) : null}
        {elsewhere && (elsewhere.count > 0 || elsewhere.on) ? (
          <button
            type="button"
            aria-pressed={elsewhere.on}
            onClick={elsewhere.onToggle}
            title={elsewhere.on ? "Showing posts other sessions already use. Click to hide them." : "Posts other sessions already use are hidden. Click to show them too."}
            className={`rounded-md border px-2 py-1 ${elsewhere.on ? "border-amber-500/50 bg-amber-500/15 text-amber-950 dark:text-amber-100" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            In other sessions · {elsewhere.count}
          </button>
        ) : null}
        {order ? (
          <select
            value={order.value}
            onChange={(e) => order.onChange(e.target.value as BrowseOrder)}
            className="ml-auto rounded-md border border-border bg-transparent px-1.5 py-1 text-muted-foreground outline-none hover:text-foreground"
            aria-label="Sort the library"
            title="The library's order (a search shows the best matches first)"
          >
            <option value="recent">Recently added</option>
            <option value="newest">Newest posted first</option>
            <option value="oldest">Oldest posted first</option>
          </select>
        ) : null}
      </div>
    </div>
  );
}
