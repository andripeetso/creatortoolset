import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { PanelLeft, PanelRight, PanelRightClose, SquarePen, X } from "lucide-react";
import type { AssistantChat } from "@contracts/assistant";
import { HomeActivity } from "@/components/HomeActivity";
import { HomeLink } from "@/components/HomeLink";
import { PlanLimitPill } from "@/components/PlanLimitPill";
import { UserMenu } from "@/components/UserMenu";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { canUse, useMe } from "@/lib/auth";
import { LIST_MAX, LIST_MIN, LIST_W, MIN_CHAT, MIN_PAGE, previewChatWidth, useChatMode, washTo, type ChatLayout } from "@/lib/chat-mode";
import { cn } from "@/lib/utils";
import { ChatList } from "./ChatList";
import { ChatModeButton } from "./ChatModeButton";

const iconBtn = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

function NewChatButton({ onNew, disabled }: { onNew: () => void; disabled: boolean }) {
  return (
    <button type="button" className={iconBtn} onClick={onNew} disabled={disabled} aria-label="Start a new chat" title="New chat">
      <SquarePen className="size-4" />
    </button>
  );
}

/**
 * The list's right edge: drag it to make the list of chats wider or narrower, as far as the open chat beside it keeps
 * its least (for more, the chats' own edge gives them more of the window). A double-click gives it its usual width.
 */
function ListEdge({ most, onDrag }: { most: number; onDrag: (w: number | null) => void }) {
  const [drag, setDrag] = useState(false);
  const width = (e: ReactPointerEvent<HTMLElement>) => Math.round(Math.min(Math.max(e.clientX - (e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0), LIST_MIN), most));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Make the list of chats wider or narrower"
      title="Drag to resize · double-click for its usual width"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(true);
      }}
      onPointerMove={(e) => drag && onDrag(width(e))}
      onPointerUp={(e) => {
        if (!drag) return;
        setDrag(false);
        useChatMode.getState().set({ lw: width(e) });
        onDrag(null);
      }}
      onDoubleClick={() => useChatMode.getState().set({ lw: 0 })}
      // just past the list's edge, not on it: the list's scroll bar stands at that edge, and is not this handle's to take
      className="group absolute inset-y-0 left-full z-10 w-2 cursor-col-resize touch-none"
    >
      <span className={cn("absolute inset-y-0 -left-px w-px transition-colors", drag ? "bg-[var(--tint)]" : "group-hover:bg-[var(--tint)]")} />
    </div>
  );
}

/**
 * The left column of chat mode: the app's name (the way Home), every chat, then the project, the account and Activity. It stands beside the open chat
 * while there is room; narrower, it opens over the chat from the list button (`onClose` then closes it again).
 */
export function ChatsAside({
  chats,
  onOpen,
  onNew,
  canNew,
  reload,
  onClose,
  layout,
}: {
  chats: AssistantChat[] | null;
  onOpen: (id: string) => Promise<unknown> | void;
  onNew: () => Promise<unknown> | void;
  /** Off while the open chat is still empty: it is the new chat. */
  canNew: boolean;
  reload: () => void;
  onClose?: () => void;
  /** Beside the open chat: how the window is shared (the list's width, and how wide its edge can drag it). */
  layout?: ChatLayout;
}) {
  const me = useMe();
  // the width while the list's edge is dragged
  const [dragged, setDragged] = useState<number | null>(null);
  // the same people Home's bar shows the project to
  const projects = canUse(me, "instagram") || canUse(me, "workshop");
  const pick = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | void) => (...a: A) => {
    onClose?.();
    return fn(...a);
  };
  return (
    <>
      {onClose && <div className="absolute inset-0 z-20 bg-black/40 motion-safe:animate-in motion-safe:fade-in" onClick={onClose} aria-hidden />}
      <aside
        aria-label="Chats"
        style={{ width: dragged ?? layout?.listW ?? LIST_W }}
        className={cn(
          "relative flex min-h-0 shrink-0 flex-col border-r bg-popover",
          onClose && "absolute inset-y-0 left-0 z-20 shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-left-4 motion-safe:duration-200",
        )}
      >
        {/* as high as the page's bar: the Mac app's window buttons sit at its start (index.css, data-chat-bar). The button
            and the name stand exactly where the page's bar has them, so switching chat mode moves neither (owner, 11-13:
            "the button underneath my mouse should not move") */}
        <header data-chat-bar className="flex h-14 shrink-0 items-center gap-1 pr-2 pl-3 select-none sm:pl-4">
          <ChatModeButton className="mr-1" />
          {/* gives way before the buttons do: in the Mac app the window's buttons take 84px of a narrow list's bar */}
          <HomeLink className="min-w-0 shrink truncate" />
          <span className="flex-1" />
          <NewChatButton onNew={() => void pick(onNew)()} disabled={!canNew} />
          {onClose && (
            <button type="button" className={iconBtn} onClick={onClose} aria-label="Close the list" title="Close">
              <X className="size-4" />
            </button>
          )}
        </header>
        <ChatList chats={chats} onOpen={pick(onOpen)} onNew={onNew} reload={reload} />
        {/* what belongs to the whole app, not to the page beside the chats, on one line: the account (its picture; the
            name is in its menu), the project (its name gives way first) and Activity (owner, 11-13: the account comes
            first). The plan warning, while there is one, has the line above */}
        <footer className="flex shrink-0 flex-col gap-1.5 border-t px-3 py-2">
          <PlanLimitPill />
          <div className="flex h-8 items-center gap-1.5">
            <UserMenu compact />
            <span className="flex min-w-0 flex-1">{projects && <ProjectSwitcher frame />}</span>
            <HomeActivity />
          </div>
        </footer>
        {layout && <ListEdge most={Math.min(LIST_MAX, layout.chat - MIN_CHAT)} onDrag={setDragged} />}
      </aside>
    </>
  );
}

/**
 * The open chat's bar in chat mode: its name and whether it is working, then the one button (hide the page for only
 * chats, or bring it back). Where the list has no room beside the chat, the buttons that live in its head move here.
 */
export function ChatHeader({
  layout,
  title,
  dot,
  onNew,
  canNew,
  onList,
  children,
}: {
  layout: ChatLayout;
  title: string;
  /** Whether the open chat is working; nothing for a new chat, which is no chat yet. */
  dot?: ReactNode;
  onNew: () => void;
  canNew: boolean;
  /** Open the folded list over the chat. */
  onList: () => void;
  children?: ReactNode;
}) {
  return (
    <header {...(layout.list ? {} : { "data-chat-bar": "" })} className={cn("flex h-14 shrink-0 items-center gap-1.5 pr-3 pl-3 select-none", !layout.list && "sm:pl-4")}>
      {!layout.list && (
        <>
          <ChatModeButton />
          <button type="button" className={iconBtn} onClick={onList} aria-label="Show the chats" title="Chats">
            <PanelLeft className="size-4" />
          </button>
        </>
      )}
      <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", layout.list && "pl-2")}>
        {dot}
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">{title}</h2>
      </span>
      {children}
      {!layout.list && <NewChatButton onNew={onNew} disabled={!canNew} />}
      {/* not where the window has no room for the page at all */}
      {!layout.forced && <button
        type="button"
        className={iconBtn}
        onClick={(e) => washTo(layout.full ? { page: true, bare: false } : { page: false }, e.currentTarget)}
        aria-pressed={!layout.full}
        aria-label={layout.full ? "Show the page beside the chats" : "Hide the page: only chats"}
        title={layout.full ? "Show the page" : "Only chats"}
      >
        {layout.full ? <PanelRight className="size-4" /> : <PanelRightClose className="size-4" />}
      </button>}
    </header>
  );
}

/**
 * The chats' right edge: drag it to share the window between the chats and the page (the page follows as you drag).
 * Dragged far enough right that the page would get under half of its least, the page is hidden; nearly to the window's
 * left, chat mode ends. A double-click goes back to half and half.
 */
export function ChatEdge() {
  const [drag, setDrag] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Share the window between the chats and the page"
      title="Drag to resize · double-click for half and half"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(true);
      }}
      onPointerMove={(e) => drag && previewChatWidth(e.clientX)}
      onPointerUp={(e) => {
        if (!drag) return;
        setDrag(false);
        const { set } = useChatMode.getState();
        const win = document.documentElement.clientWidth || window.innerWidth;
        if (e.clientX < 200) washTo({ on: false }, e.currentTarget);
        else if (e.clientX > win - MIN_PAGE / 2) washTo({ page: false }, e.currentTarget);
        else set({ w: previewChatWidth(e.clientX) });
      }}
      onDoubleClick={() => useChatMode.getState().set({ w: 0 })}
      className="group absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none"
    >
      <span className={cn("absolute inset-y-0 right-0 w-px transition-colors", drag ? "bg-[var(--tint)]" : "group-hover:bg-[var(--tint)]")} />
    </div>
  );
}
