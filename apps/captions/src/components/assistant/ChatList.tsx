import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { AlarmClock, AlarmClockOff, Check, ChevronDown, Clock, Loader2, Pin, PinOff, Search, Trash2, Undo2, X } from "lucide-react";
import type { AssistantChat } from "@contracts/assistant";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deletePast, pinChat, renameChat, settleChat, snoozeChat, unreadChat } from "@/lib/assistant";
import { confirmDialog } from "@/lib/dialogs";
import { localInput, snoozeChoices, snoozeLeft } from "@/lib/snooze";
import { useWorkspace } from "@/lib/workspace";
import { onTopic } from "@/lib/sync";
import { undoable } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { WorkingFor } from "./WorkCards";
import { WORK_ICONS } from "./work-icons";

/** The longest a timer may wait (a longer one fires at once): past that the half-minute look brings a chat back. */
const TIMER_MOST = 24 * 3600_000;

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
  // A chat put away comes back at its time: the list is read again then. On time while the window is open and the
  // computer awake; else at the next look (every half minute while anything is away, and when the window is shown
  // again), which also covers a computer that slept and a clock a little ahead of the server's.
  const next = Math.min(...(chats ?? []).flatMap((c) => (c.snoozed ? [c.snoozed] : [])));
  useEffect(() => {
    if (!on || !Number.isFinite(next)) return;
    const look = () => Date.now() >= next && load();
    const shown = () => document.visibilityState === "visible" && look();
    const every = setInterval(look, 30_000);
    const due = next - Date.now() < TIMER_MOST ? setTimeout(load, Math.max(next - Date.now(), 0) + 1000) : undefined;
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(every);
      clearTimeout(due);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [on, next, load]);
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
 * The list's order: the pinned chats first (the newest pin on top), then what asks you something, what is still
 * working, and the rest (what finished since you looked, then the others), newest first in each. Chats put away till
 * later and settled chats are apart, each in its own fold: the ones put away by when they come back. A chat nothing
 * was said in is not in the list: it is the new-chat screen, and no chat until its first message. `query` keeps the
 * chats whose title or newest line has every word of it.
 */
export function groupChats(chats: AssistantChat[], query = ""): { groups: ChatGroup[]; snoozed: AssistantChat[]; settled: AssistantChat[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (c: AssistantChat) => words.every((w) => `${c.title} ${c.last}`.toLowerCase().includes(w));
  const all = chats.filter((c) => c.count && hit(c));
  const settled = all.filter((c) => c.settled && !c.asks && !c.working);
  const snoozed = all.filter((c) => c.snoozed && !settled.includes(c)).sort((a, b) => a.snoozed! - b.snoozed!);
  const here = all.filter((c) => !settled.includes(c) && !snoozed.includes(c));
  const loose = here.filter((c) => !c.pinned);
  const rest = loose.filter((c) => !c.asks && !c.working);
  const done = (c: AssistantChat) => !!c.unread && !c.open;
  return {
    groups: [
      { name: "Pinned", chats: here.filter((c) => c.pinned).sort((a, b) => b.pinned! - a.pinned!) },
      { name: "Needs you", chats: loose.filter((c) => c.asks) },
      { name: "Working", chats: loose.filter((c) => !c.asks && c.working) },
      { name: "Recent", chats: [...rest.filter(done), ...rest.filter((c) => !done(c))] },
    ].filter((g) => g.chats.length),
    snoozed,
    settled,
  };
}

/** The address that opens a chat (any page of the app opens it): what its menu copies as its link. */
const chatLink = (id: string) => `${window.location.origin}/?chat=${id}`;

const rowBtn = "flex items-center rounded-md px-1.5 text-muted-foreground hover:bg-background hover:text-foreground";

/**
 * The chats in chat mode. On a row, under the pointer, the time gives its place to two buttons: the clock puts the
 * chat away until a time (it is back then, or sooner if it asks something or fails), and Settle is done with it, kept
 * (it folds under Settled on every device). ⌘Z takes back a settle, a snooze or an unpin. A right-click has the rest:
 * pin, rename (also a double-click, or F2), mark unread, copy the chat's link or id, the project's settings, and
 * delete, which asks first. Settling, putting away or deleting the open chat opens the next one. The search box
 * narrows the list as you type: ↓ and ↑ move through it, Enter opens, Escape clears.
 */
export function ChatList({ chats, onOpen, onNew, reload }: { chats: AssistantChat[] | null; onOpen: (id: string) => Promise<unknown> | void; onNew: () => Promise<unknown> | void; reload: () => void }) {
  const navigate = useNavigate();
  // a chat works in the account's current project: its menu opens that project's settings
  const project = useWorkspace((s) => s.currentProjectId);
  const [showSettled, setShowSettled] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(-1);
  /** The row whose menu is open (its buttons stay while it is), the one being renamed, the one a time is being picked for. */
  const [menuOf, setMenuOf] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [custom, setCustom] = useState<AssistantChat | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const { groups, snoozed, settled } = useMemo(() => groupChats(chats ?? [], query), [chats, query]);
  // while searching, the folded chats are in the list too: a search finds everything
  const searching = !!query.trim();
  const snoozedOpen = showSnoozed || searching;
  const settledOpen = showSettled || searching;
  const rows = useMemo(() => [...groups.flatMap((g) => g.chats), ...(snoozedOpen ? snoozed : []), ...(settledOpen ? settled : [])], [groups, snoozed, settled, snoozedOpen, settledOpen]);
  useEffect(() => setAt(-1), [query]);
  // not read yet: its room is kept, so what stands under the list is in its place from the first moment
  if (!chats) return <div className="flex-1" />;

  /** The chat to show once `gone` leaves the list: the next one that is neither folded away nor it, else a new chat. */
  const moveOn = async (gone: AssistantChat) => {
    if (!gone.open) return;
    const next = groups.flatMap((g) => g.chats).find((c) => c.id !== gone.id);
    await (next ? onOpen(next.id) : onNew());
  };
  /** What a settle takes from a chat besides its place: its pin and its snooze. An undo gives them back, the pin where it was. */
  const giveBack = async (c: AssistantChat) => {
    if (c.pinned) await pinChat(c.id, true, c.pinned);
    // (a time that has passed meanwhile is refused there, and the chat stays in the list)
    if (c.snoozed) await snoozeChat(c.id, c.snoozed);
  };
  const settle = (c: AssistantChat, on: boolean) =>
    void (async () => {
      const r = await settleChat(c.id, on);
      if (r.ok && on) {
        await moveOn(c);
        undoable("settled", async () => {
          await settleChat(c.id, false);
          await giveBack(c);
          reload();
        });
      }
      reload();
    })();
  /** Put a chat away until `until`, or bring it back now (null). */
  const snooze = (c: AssistantChat, until: number | null) =>
    void (async () => {
      if (until !== null && until <= Date.now()) return void toast.error("That time has passed. Choose another.");
      const r = await snoozeChat(c.id, until);
      if (r.ok && until !== null) {
        await moveOn(c);
        undoable("snoozed", async () => {
          await snoozeChat(c.id, c.snoozed && c.snoozed > Date.now() ? c.snoozed : null);
          reload();
        });
      }
      reload();
    })();
  const pin = (c: AssistantChat, on: boolean) =>
    void (async () => {
      const r = await pinChat(c.id, on);
      if (r.ok && !on)
        undoable("unpinned", async () => {
          await pinChat(c.id, true, c.pinned);
          reload();
        });
      reload();
    })();
  const rename = (c: AssistantChat, title: string) =>
    void (async () => {
      setRenaming(null);
      const name = title.replace(/\s+/g, " ").trim();
      if (name === chatTitle(c)) return;
      if (!name) return void toast.error("A chat's name cannot be empty");
      await renameChat(c.id, name);
      reload();
    })();
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`, { description: text }), () => toast.error("Could not copy it"));
  const remove = (c: AssistantChat) =>
    void (async () => {
      if (!(await confirmDialog({ title: `Delete "${chatTitle(c)}"?`, body: "The chat and its pictures are deleted for good.", ok: "Delete", danger: true }))) return;
      // the open chat is put among the others first: only those can be deleted
      await moveOn(c);
      await deletePast(c.id);
      reload();
    })();

  const snoozeItems = (c: AssistantChat, menu: "context" | "dropdown") => <SnoozeItems menu={menu} onPick={(until) => snooze(c, until)} onCustom={() => setCustom(c)} />;

  const row = (c: AssistantChat) => {
    const marked = rows[at]?.id === c.id;
    const title = chatTitle(c);
    const Made = c.on && WORK_ICONS[c.on.kind];
    // what the row's own buttons are: a settled chat comes back, one put away wakes, any other is put away or settled
    const buttons: ReactNode = c.settled ? (
      <button type="button" onClick={() => settle(c, false)} className={rowBtn} aria-label={`Un-settle "${title}"`} title="Un-settle">
        <Undo2 className="size-3.5" />
      </button>
    ) : c.snoozed ? (
      <button type="button" onClick={() => snooze(c, null)} className={rowBtn} aria-label={`Wake "${title}" now`} title="Wake now">
        <AlarmClockOff className="size-3.5" />
      </button>
    ) : (
      <>
        {/* one that asks you something is back the moment it is put away: it has no clock */}
        {!c.asks && <DropdownMenu onOpenChange={(o) => setMenuOf(o ? c.id : null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={rowBtn} aria-label={`Snooze "${title}"`} title="Snooze: put it away until later">
              <Clock className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            {snoozeItems(c, "dropdown")}
          </DropdownMenuContent>
        </DropdownMenu>}
        {!c.working && (
          <button type="button" onClick={() => settle(c, true)} className={cn(rowBtn, "-mr-1 gap-1 text-xs")} aria-label={`Settle "${title}"`} title="Settle: done with it, kept">
            <Check className="size-3.5" />
            Settle
          </button>
        )}
      </>
    );
    return (
      <ContextMenu key={c.id} onOpenChange={(o) => setMenuOf(o ? c.id : null)}>
        <ContextMenuTrigger asChild>
          <li
            data-menu={menuOf === c.id || undefined}
            onDoubleClick={() => setRenaming(c.id)}
            className={cn("chat-row relative rounded-lg", c.open ? "bg-zinc-500/15" : marked || menuOf === c.id ? "bg-zinc-500/10" : "hover:bg-zinc-500/10")}
          >
            {/* the whole row opens the chat; what stands on it (the pin, the buttons, the name's box) is over this */}
            <button
              type="button"
              // (the second press of a double-click is the rename's, not another opening)
              onClick={(e) => e.detail < 2 && void onOpen(c.id)}
              onKeyDown={(e) => e.key === "F2" && setRenaming(c.id)}
              aria-current={c.open || undefined}
              aria-label={title}
              className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--violet-600))]"
            />
            <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
              <span className="flex h-5 min-w-0 items-center gap-1.5">
                {!!c.pinned && (
                  <button type="button" onClick={() => pin(c, false)} className="group/pin pointer-events-auto -ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Unpin "${title}"`} title="Unpin">
                    <Pin className="size-3 group-hover/pin:hidden" />
                    <PinOff className="hidden size-3 group-hover/pin:block" />
                  </button>
                )}
                {renaming === c.id ? (
                  <NameBox name={title} onName={(name) => rename(c, name)} onCancel={() => setRenaming(null)} />
                ) : (
                  <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", (c.settled || c.snoozed || !c.count) && "text-muted-foreground")}>{title}</span>
                )}
                {/* the time and the buttons share this place (index.css, .chat-row): it is as wide as the one on show, so only the name gets shorter */}
                <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end">
                  <span className="chat-row-when flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                    {c.snoozed ? (
                      <span className="flex items-center gap-1" title={`Back ${new Date(c.snoozed).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`}>
                        <AlarmClock className="size-3" aria-label="Snoozed for" />
                        {snoozeLeft(c.snoozed)}
                      </span>
                    ) : c.asks ? (
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
                    ) : c.woke && !c.open ? (
                      <span className="flex items-center gap-1 font-medium text-amber-500">
                        <AlarmClock className="size-3" aria-hidden />
                        Woke
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
                  {!!c.count && renaming !== c.id && <span className="chat-row-do flex items-stretch">{buttons}</span>}
                </span>
              </span>
              {(c.on || c.last) && (
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  {Made && (
                    <span className="flex max-w-[60%] shrink-0 items-center gap-1 text-foreground/70" title={`It last made: ${c.on!.title}`}>
                      <Made className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{c.on!.title}</span>
                      {c.last && <span aria-hidden>·</span>}
                    </span>
                  )}
                  <span className="min-w-0 truncate">{c.last}</span>
                </span>
              )}
            </div>
          </li>
        </ContextMenuTrigger>
        {/* the focus does not go back to the row when the menu closes: Rename's box takes it */}
        <ContextMenuContent className="min-w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenuItem onSelect={() => void onNew()}>New chat</ContextMenuItem>
          <ContextMenuItem onSelect={() => pin(c, !c.pinned)}>{c.pinned ? "Unpin chat" : "Pin chat"}</ContextMenuItem>
          {!c.working && <ContextMenuItem onSelect={() => settle(c, !c.settled)}>{c.settled ? "Un-settle chat" : "Settle chat"}</ContextMenuItem>}
          {c.snoozed ? (
            <ContextMenuItem onSelect={() => snooze(c, null)}>Wake chat</ContextMenuItem>
          ) : c.asks ? null : (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Snooze</ContextMenuSubTrigger>
              <ContextMenuSubContent className="min-w-52">{snoozeItems(c, "context")}</ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setRenaming(c.id)}>Rename chat</ContextMenuItem>
          {/* the open chat is being looked at: it cannot be not looked at */}
          {!c.open && !c.working && !c.unread && (
            <ContextMenuItem
              onSelect={() =>
                void unreadChat(c.id).then((r) => {
                  if (!r.ok) toast.error(r.error);
                  reload();
                })
              }
            >
              Mark unread
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>Copy</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => copy(chatLink(c.id), "Chat link")}>Chat link</ContextMenuItem>
              <ContextMenuItem onSelect={() => copy(c.id, "Chat ID")}>Chat ID</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={() => navigate(project ? `/projects?edit=${encodeURIComponent(project)}` : "/projects")}>Project settings</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => remove(c)}>
            <Trash2 />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  const head = "flex items-center justify-between px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase";
  /** A fold under the list: chats put away till later, settled chats. Open while searching. */
  const fold = (name: string, list: AssistantChat[], open: boolean, toggle: () => void) =>
    !!list.length && (
      <section>
        <button type="button" onClick={toggle} aria-expanded={open} disabled={searching} className={cn(head, "w-full gap-2 pb-0 hover:text-foreground disabled:hover:text-muted-foreground/80")}>
          {name}
          <span className="h-px flex-1 bg-border" />
          <span className="tabular-nums">{list.length}</span>
          {!searching && <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />}
        </button>
        {open && <ul className="mt-1 flex flex-col gap-px">{list.map(row)}</ul>}
      </section>
    );
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
        {!rows.length && !snoozed.length && !settled.length && <p className="px-2.5 py-1 text-[13px] text-muted-foreground">{searching ? "No chat has those words." : "No chats yet."}</p>}
        {fold("Snoozed", snoozed, snoozedOpen, () => setShowSnoozed((v) => !v))}
        {fold("Settled", settled, settledOpen, () => setShowSettled((v) => !v))}
      </div>
      {/* made anew for each chat it is opened for: its time starts an hour from then */}
      <SnoozeUntil key={custom?.id ?? ""} chat={custom} onClose={() => setCustom(null)} onPick={(until) => custom && snooze(custom, until)} />
    </div>
  );
}

/**
 * The times a chat can be put away until, in either kind of menu. Worked out when the menu opens (it is drawn only
 * then), and the one picked again at the click: "In 1 hour" is an hour from the click.
 */
function SnoozeItems({ menu, onPick, onCustom }: { menu: "context" | "dropdown"; onPick: (until: number) => void; onCustom: () => void }) {
  const Item = menu === "context" ? ContextMenuItem : DropdownMenuItem;
  const Line = menu === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <>
      {snoozeChoices().map((s) => (
        <Item key={s.label} onSelect={() => onPick(snoozeChoices().find((x) => x.label === s.label)?.until ?? s.until)}>
          {s.label}
          <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{s.when}</span>
        </Item>
      ))}
      <Line />
      <Item onSelect={onCustom}>Custom…</Item>
    </>
  );
}

/**
 * A chat's name in a box on its row: Enter or a click elsewhere names it, Escape leaves it as it was. The box takes
 * the focus, its text selected, once the menu it was asked from is gone (a menu that is closing still holds the focus).
 */
function NameBox({ name, onName, onCancel }: { name: string; onName: (name: string) => void; onCancel: () => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const take = () => {
      if (document.querySelector('[role="menu"]') && tries++ < 40) return void (frame = requestAnimationFrame(take));
      box.current?.focus();
      box.current?.select();
    };
    take();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <input
      ref={box}
      defaultValue={name}
      aria-label="The chat's name"
      onBlur={(e) => onName(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="pointer-events-auto -mx-1 h-5 min-w-0 flex-1 rounded bg-background px-1 text-[13px] font-medium text-foreground outline-none ring-1 ring-[rgb(var(--violet-600))]"
    />
  );
}

/** Custom…: a date and a time to put a chat away until (an hour from now, until another is picked). */
function SnoozeUntil({ chat, onClose, onPick }: { chat: AssistantChat | null; onClose: () => void; onPick: (until: number) => void }) {
  const [when, setWhen] = useState(() => localInput(Date.now() + 3600_000));
  const until = when ? new Date(when).getTime() : Number.NaN;
  return (
    <Dialog open={!!chat} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze until</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (Number.isNaN(until)) return;
            onPick(until);
            onClose();
          }}
        >
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Date and time" className="h-9 rounded-md border bg-background px-2.5 text-sm text-foreground" autoFocus />
          <DialogFooter>
            <button type="button" onClick={onClose} className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
              Cancel
            </button>
            <button type="submit" disabled={Number.isNaN(until)} className="h-8 rounded-md bg-[rgb(var(--violet-600))] px-3 text-sm font-medium text-white disabled:opacity-50">
              Snooze
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
