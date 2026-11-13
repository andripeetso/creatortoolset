import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { AssistantChat } from "@contracts/assistant";
import { deletePast, settleChat } from "@/lib/assistant";
import { confirmDialog } from "@/lib/dialogs";
import { onTopic } from "@/lib/sync";
import { undoable } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { WorkingFor } from "./WorkCards";

/** Every chat (GET /api/assistant/chats), read again whenever the server says the assistant changed. */
export function useChats(on: boolean): [AssistantChat[] | null, () => void] {
  const [chats, setChats] = useState<AssistantChat[] | null>(null);
  const load = useCallback(() => {
    void fetch("/api/assistant/chats", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<{ chats: AssistantChat[] }>) : null))
      .then((d) => d && setChats(d.chats))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!on) return;
    load();
    return onTopic("assistant", load);
  }, [on, load]);
  return [chats, load];
}

export const ago = (at: number) => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`;
  if (mins < 7 * 24 * 60) return `${Math.round(mins / 1440)}d`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
};

/** A chat nothing was said in yet has no first message to be named after. */
export const chatTitle = (c: Pick<AssistantChat, "title" | "count">) => (c.count ? c.title : "New chat");

export type ChatGroup = { name: string; chats: AssistantChat[] };

/**
 * The list's order: what asks you something first, then what is still working, then the rest (the new chat you are
 * in, then what finished since you looked, then the others), newest first in each. Settled chats are apart. `query`
 * keeps the chats whose title or newest line has every word of it.
 */
export function groupChats(chats: AssistantChat[], query = ""): { groups: ChatGroup[]; settled: AssistantChat[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (c: AssistantChat) => words.every((w) => `${c.title} ${c.last}`.toLowerCase().includes(w));
  const all = chats.filter(hit);
  const rest = all.filter((c) => !c.asks && !c.working && !c.settled);
  const fresh = (c: AssistantChat) => !c.count && !!c.open;
  const done = (c: AssistantChat) => !!c.unread && !c.open;
  return {
    groups: [
      { name: "Needs you", chats: all.filter((c) => c.asks) },
      { name: "Working", chats: all.filter((c) => !c.asks && c.working) },
      { name: "Recent", chats: [...rest.filter(fresh), ...rest.filter((c) => !fresh(c) && done(c)), ...rest.filter((c) => !fresh(c) && !done(c))] },
    ].filter((g) => g.chats.length),
    settled: all.filter((c) => c.settled && !c.asks && !c.working),
  };
}

/**
 * The chats in chat mode. A tick settles a chat (it folds under Settled on every device, ⌘Z brings it back); the bin
 * deletes it for good, after asking. Settling or deleting the open chat opens the next one. The search box narrows the
 * list as you type: ↓ and ↑ move through it, Enter opens, Escape clears.
 */
export function ChatList({ chats, onOpen, onNew, reload }: { chats: AssistantChat[] | null; onOpen: (id: string) => Promise<unknown> | void; onNew: () => Promise<unknown> | void; reload: () => void }) {
  const [showSettled, setShowSettled] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(-1);
  const box = useRef<HTMLInputElement>(null);
  const { groups, settled } = useMemo(() => groupChats(chats ?? [], query), [chats, query]);
  // while searching, settled chats are in the list too: a search finds everything
  const settledOpen = showSettled || !!query.trim();
  const rows = useMemo(() => [...groups.flatMap((g) => g.chats), ...(settledOpen ? settled : [])], [groups, settled, settledOpen]);
  useEffect(() => setAt(-1), [query]);
  if (!chats) return null;

  /** The chat to show once `gone` leaves the list: the next one that is neither settled nor it, else a new chat. */
  const moveOn = async (gone: AssistantChat) => {
    if (!gone.open) return;
    const next = groups.flatMap((g) => g.chats).find((c) => c.id !== gone.id);
    await (next ? onOpen(next.id) : onNew());
  };
  const settle = (c: AssistantChat, on: boolean) =>
    void (async () => {
      const r = await settleChat(c.id, on);
      if (r.ok && on) {
        await moveOn(c);
        undoable("settled", () => settle(c, false));
      }
      reload();
    })();
  const remove = (c: AssistantChat) =>
    void (async () => {
      if (!(await confirmDialog({ title: `Delete "${chatTitle(c)}"?`, body: "The chat and its pictures are deleted for good.", ok: "Delete", danger: true }))) return;
      // the open chat is put among the others first: only those can be deleted
      await moveOn(c);
      await deletePast(c.id);
      reload();
    })();

  const row = (c: AssistantChat) => {
    const marked = rows[at]?.id === c.id;
    return (
      <li key={c.id} className={cn("group/chat relative rounded-lg", c.open ? "bg-zinc-500/15" : marked ? "bg-zinc-500/10" : "hover:bg-zinc-500/10")}>
        <button type="button" onClick={() => void onOpen(c.id)} aria-current={c.open || undefined} className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--violet-600))]">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", (c.settled || !c.count) && "text-muted-foreground")}>{chatTitle(c)}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums group-hover/chat:invisible group-focus-within/chat:invisible">
              {c.asks ? (
                <>
                  <span className="size-2 rounded-full bg-[rgb(var(--violet-600))] ring-[3px] ring-[rgb(var(--violet-600)/0.2)]" aria-label="Asks you something" />
                  {ago(c.at)}
                </>
              ) : c.working ? (
                // a working chat's newest message is the reply it is writing: its time is when the work started
                <span className="flex items-center gap-1.5 text-[rgb(var(--violet-600))]">
                  <Loader2 className="size-3 motion-safe:animate-spin" aria-label="Working" />
                  <WorkingFor since={c.at} compact />
                </span>
              ) : c.unread && !c.open ? (
                <span className="flex items-center gap-1 font-medium text-emerald-500">
                  <Check className="size-3" aria-hidden />
                  Done
                </span>
              ) : c.count ? (
                ago(c.at)
              ) : null}
            </span>
          </span>
          {c.last && <span className="truncate text-xs text-muted-foreground">{c.last}</span>}
        </button>
        <span className="absolute top-1 right-1 hidden items-center gap-0.5 rounded-md bg-popover/80 group-focus-within/chat:flex group-hover/chat:flex">
          {!c.working && !!c.count && (
            <button
              type="button"
              onClick={() => settle(c, !c.settled)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={c.settled ? `Un-settle "${chatTitle(c)}"` : `Settle "${chatTitle(c)}"`}
              title={c.settled ? "Un-settle" : "Settle: done with it, kept"}
            >
              {c.settled ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
            </button>
          )}
          {!!c.count && (
            <button
              type="button"
              onClick={() => remove(c)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-destructive"
              aria-label={`Delete "${chatTitle(c)}"`}
              title="Delete for good"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </li>
    );
  };
  const head = "flex items-center justify-between px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="mx-2 mt-2 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-zinc-500/10 px-2.5 text-muted-foreground focus-within:ring-1 focus-within:ring-[rgb(var(--violet-600))]">
        <Search className="size-3.5 shrink-0" aria-hidden />
        <input
          ref={box}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            } else if (e.key === "Enter" && rows[Math.max(at, 0)]) {
              void onOpen(rows[Math.max(at, 0)]!.id);
              setQuery("");
            } else if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search chats"
          aria-label="Search chats"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <button type="button" onClick={() => (setQuery(""), box.current?.focus())} aria-label="Clear the search" className="rounded p-0.5 hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
      </label>
      {/* keeps its bar's room at all times: a list that starts to scroll moves nothing; scrolling it never scrolls the page */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-scroll overscroll-contain py-2 pr-2 pl-2 bars:pr-0">
        {groups.map((g) => (
          <section key={g.name}>
            <h3 className={head}>
              {g.name}
              <span className="tabular-nums">{g.chats.length}</span>
            </h3>
            <ul className="flex flex-col gap-px">{g.chats.map(row)}</ul>
          </section>
        ))}
        {!rows.length && !settled.length && <p className="px-2.5 py-1 text-[13px] text-muted-foreground">{query.trim() ? "No chat has those words." : "No chats yet."}</p>}
        {!!settled.length && (
          <section>
            <button type="button" onClick={() => setShowSettled((v) => !v)} aria-expanded={settledOpen} disabled={!!query.trim()} className={cn(head, "w-full gap-2 pb-0 hover:text-foreground disabled:hover:text-muted-foreground/80")}>
              Settled
              <span className="h-px flex-1 bg-border" />
              <span className="tabular-nums">{settled.length}</span>
              {!query.trim() && <ChevronDown className={cn("size-3.5 transition-transform", showSettled && "rotate-180")} />}
            </button>
            {settledOpen && <ul className="mt-1 flex flex-col gap-px">{settled.map(row)}</ul>}
          </section>
        )}
      </div>
    </div>
  );
}
