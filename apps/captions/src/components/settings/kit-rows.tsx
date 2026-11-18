import { Children, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ChevronRight, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PageTitleContext } from "./page-action";
import type { SearchRowId } from "./search";

/*
 * The Settings kit, rows and sections. Import everything from "./ui" (the barrel), never from these files.
 * Every component that takes `id` registers it for search (search.ts): the id must be in the index.
 */

/**
 * A section: `h2 text-base font-semibold`, an optional action on the right of the title (e.g. a `size="xs"` button "+ Add
 * computer"), then its cards or rows. Never text under the title. `id` lets a search result land on the section.
 * The page's header already prints the page's name ("Settings › Folders"), so a section named the same prints no title;
 * its action stays at the right. Outside the Settings frame (a static render) the title is always printed.
 */
export function Section({ id, title, action, children, className }: { id?: SearchRowId; title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  const named = title !== useContext(PageTitleContext);
  return (
    <section data-settings-row={id} className={cn("space-y-2.5", className)}>
      {(named || action) && (
        <div className={cn("flex min-h-7 items-center gap-4 px-0.5", named ? "justify-between" : "justify-end")}>
          {named && <h2 className="text-base font-semibold text-foreground">{title}</h2>}
          {action && <div className="flex shrink-0 items-center">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A rounded card of rows, with hairlines between its children. Rows, ListRows and EmptyRows go inside. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-card/40 text-foreground [&>*+*]:border-t [&>*+*]:border-border/50", className)}>
      {children}
    </div>
  );
}

/**
 * The ⓘ after a label. Hover and keyboard focus open a tooltip after 350 ms; a tap opens a popover (Radix tooltips do not
 * open on tap). The tooltip closes on press, so a tap never shows both.
 */
export function InfoTip({ text }: { text: ReactNode }) {
  const [tapped, setTapped] = useState(false);
  return (
    <Popover open={tapped} onOpenChange={setTapped}>
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="About this"
              className="ml-1.5 inline-flex size-4 shrink-0 translate-y-px items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 whitespace-normal text-left leading-snug">
          {text}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" className="w-64 text-xs leading-snug">
        {text}
      </PopoverContent>
    </Popover>
  );
}

interface RowProps {
  id?: SearchRowId;
  /** The label, a few words. */
  title: ReactNode;
  /** The ⓘ tooltip text after the title: one sentence, at most two, ending with a full stop. No tip where the title says it all. */
  tip?: ReactNode;
  /** One short line, only when it adds something the title doesn't say. */
  description?: ReactNode;
  /** Muted text under the title. Amber or red only through `<Status tone>` when the person must act. */
  status?: ReactNode;
  /** The control, on the right from `sm` up and under the title below it. */
  control?: ReactNode;
  /** Full-width area under the row (a list, a form). */
  children?: ReactNode;
  className?: string;
}

/** @deprecated The old `Row({ label, hint, children })` shape: `children` is the control. Use title/description/control. */
interface LegacyRowProps {
  id?: SearchRowId;
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * A setting row: title, one description line, optional status, the control on the right (under the title below `sm`),
 * and a full-width `children` area under it. Put rows inside a Card. Its `id` makes the row searchable and landable.
 */
export function Row(props: RowProps | LegacyRowProps) {
  if ("label" in props) return <RowBody id={props.id} title={props.label} description={props.hint} control={props.children} className={props.className} />;
  return <RowBody {...props} />;
}

function RowBody({ id, title, tip, description, status, control, children, className }: RowProps) {
  return (
    <div data-settings-row={id} className={cn("px-3 py-3 sm:px-4", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-sm font-medium text-foreground">
            {title}
            {tip && <InfoTip text={tip} />}
          </div>
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
          {status && <div className="pt-0.5 text-xs text-muted-foreground">{status}</div>}
        </div>
        {control && <div className="flex min-w-0 shrink-0 items-center gap-2 sm:justify-end">{control}</div>}
      </div>
      {Children.toArray(children).length > 0 && <div className="pt-3">{children}</div>}
    </div>
  );
}

/**
 * A thing in a list (a computer, a provider, an account, a key, a task, a member): icon, title, one subtitle line, one
 * status line, and the actions on the right: a `size="sm"` button or an `InUse` word, then the `RowMenu` last. One line
 * each: long text truncates. (`size="xs"` is only the ghost "+ Add" beside a section's title.)
 */
export function ListRow({ id, icon, title, tip, subtitle, status, actions, className }: {
  id?: SearchRowId;
  icon?: ReactNode;
  title: ReactNode;
  /** The ⓘ tooltip after the title, as on Row. */
  tip?: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-settings-row={id}
      className={cn(
        "grid items-center gap-x-3 px-3 py-2.5 sm:px-4",
        icon ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        className,
      )}
    >
      {icon && <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
          {tip && <InfoTip text={tip} />}
        </div>
        {/* below sm a long line wraps to two lines instead of being cut mid-word */}
        {subtitle && <div className="line-clamp-2 break-words text-xs text-muted-foreground sm:line-clamp-1">{subtitle}</div>}
        {status && <div className="min-w-0 pt-0.5 text-xs text-muted-foreground">{status}</div>}
      </div>
      {/* as tall as a row button (sm), so a row whose right end is a word (InUse) is as tall as one with a button */}
      {actions && <div className="flex min-h-8 shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** An empty list is a row: the title says what is missing, the description says what the thing is (one sentence). */
export function EmptyRow({ id, title, description }: { id?: SearchRowId; title: ReactNode; description?: ReactNode }) {
  return (
    <div data-settings-row={id} className="px-3 py-3 sm:px-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </div>
  );
}

/** Loading, as a row inside the card (not a box). */
export function LoadingRow({ title = "Loading…" }: { title?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground sm:px-4">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {title}
    </div>
  );
}

/** A failed load, as a row inside the card. `retry` adds a "Retry" button. */
export function ErrorRow({ title, detail, retry }: { title: ReactNode; detail?: ReactNode; retry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-red-600 dark:text-red-400">{title}</div>
        {detail && <div className="truncate text-xs text-muted-foreground">{detail}</div>}
      </div>
      {retry && (
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * A folded card (e.g. Load balancing): the header row has the chevron, the title, a muted summary and a
 * control on the right (a Switch); the rows are inside. Opens by itself when a search result lands on or inside it.
 */
export function Folded({ id, title, summary, control, children }: { id?: SearchRowId; title: ReactNode; summary?: ReactNode; control?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { hash } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = decodeURIComponent(hash.slice(1));
    if (row && (row === id || ref.current?.querySelector(`[data-settings-row="${CSS.escape(row)}"]`))) setOpen(true);
  }, [hash, id]);
  return (
    <div ref={ref} data-settings-row={id} className="rounded-xl border border-border/60 bg-card/40 text-foreground">
      <div className="flex items-center gap-4 px-3 sm:px-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
          <span className="shrink-0 text-sm font-medium">{title}</span>
          {summary && <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
        </button>
        {control && <div className="flex shrink-0 items-center">{control}</div>}
      </div>
      <div hidden={!open} className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
        {children}
      </div>
    </div>
  );
}

/**
 * A folded disclosure row for the rare settings. Opens by itself when a search result lands inside it. The content stays
 * in the DOM while closed (hidden), so the search can find and open it.
 */
export function Advanced({ summary = "Advanced", children }: { summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { hash } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = decodeURIComponent(hash.slice(1));
    if (row && ref.current?.querySelector(`[data-settings-row="${CSS.escape(row)}"]`)) setOpen(true);
  }, [hash]);
  return (
    <div ref={ref} className="[&>*+*]:border-t [&>*+*]:border-border/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        {summary}
      </button>
      <div hidden={!open} className="px-3 pb-3 sm:px-4 [&>*+*]:border-t [&>*+*]:border-border/50">
        {children}
      </div>
    </div>
  );
}
