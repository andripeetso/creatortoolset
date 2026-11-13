import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, RotateCcw, Trash2 } from "lucide-react";
import type { AssistantChat } from "@contracts/assistant";
import { deletePast, settleChat } from "@/lib/assistant";
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

/**
 * The chats in chat mode, grouped by what they need: one that asks you something first, then the ones still working,
 * then the rest. A tick settles a chat (it folds under Settled on every device, ⌘Z brings it back); the bin deletes it.
 */
export function ChatList({ chats, onOpen, reload }: { chats: AssistantChat[] | null; onOpen: (id: string) => void; reload: () => void }) {
  const [showSettled, setShowSettled] = useState(false);
  if (!chats) return null;
  const settle = (c: AssistantChat, on: boolean) =>
    void settleChat(c.id, on).then((r) => {
      reload();
      if (r.ok && on) undoable("settled", () => settle(c, false));
    });
  const groups: Array<[string, AssistantChat[]]> = [
    ["Needs you", chats.filter((c) => c.asks)],
    ["Working", chats.filter((c) => !c.asks && c.working)],
    ["Recent", chats.filter((c) => !c.asks && !c.working && !c.settled)],
  ];
  const settled = chats.filter((c) => c.settled && !c.asks && !c.working);
  const row = (c: AssistantChat) => (
    <li key={c.id} className={cn("group/chat relative rounded-lg", c.open ? "bg-zinc-500/15" : "hover:bg-zinc-500/10")}>
      <button type="button" onClick={() => onOpen(c.id)} aria-current={c.open || undefined} className="flex w-full min-w-0 items-start gap-2 px-2.5 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px] font-medium", c.settled && "text-muted-foreground")}>{c.title}</span>
          {c.last && <span className="block truncate text-xs text-muted-foreground">{c.last}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5 text-[11px] text-muted-foreground tabular-nums group-hover/chat:invisible group-focus-within/chat:invisible">
          {c.asks ? (
            <span className="size-2 rounded-full bg-[rgb(var(--violet-600))] ring-[3px] ring-[rgb(var(--violet-600)/0.2)]" aria-label="Asks you something" />
          ) : c.working ? (
            <Loader2 className="size-3.5 text-[rgb(var(--violet-600))] motion-safe:animate-spin" aria-hidden />
          ) : null}
          {/* a working chat's newest message is the reply it is writing: its time is when the work started */}
          {c.working && !c.asks ? (
            <span className="text-[rgb(var(--violet-600))]">
              Working <WorkingFor since={c.at} compact />
            </span>
          ) : (
            ago(c.at)
          )}
        </span>
      </button>
      <span className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 group-focus-within/chat:flex group-hover/chat:flex">
        {!c.working && (
          <button
            type="button"
            onClick={() => settle(c, !c.settled)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={c.settled ? `Un-settle "${c.title}"` : `Settle "${c.title}"`}
            title={c.settled ? "Un-settle" : "Settle"}
          >
            {c.settled ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => void deletePast(c.id).then(reload)}
          disabled={c.open}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-destructive disabled:hidden"
          aria-label={`Delete "${c.title}"`}
          title="Delete for good"
        >
          <Trash2 className="size-3.5" />
        </button>
      </span>
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      {groups.map(([name, list]) =>
        list.length ? (
          <section key={name}>
            <h3 className="flex justify-between px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
              {name}
              <span className="tabular-nums">{list.length}</span>
            </h3>
            <ul className="flex flex-col gap-px">{list.map(row)}</ul>
          </section>
        ) : null,
      )}
      {!!settled.length && (
        <section>
          <button
            type="button"
            onClick={() => setShowSettled((v) => !v)}
            aria-expanded={showSettled}
            className="flex w-full items-center gap-2 px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase hover:text-foreground"
          >
            Settled
            <span className="h-px flex-1 bg-border" />
            <span className="tabular-nums">{settled.length}</span>
            <ChevronDown className={cn("size-3.5 transition-transform", showSettled && "rotate-180")} />
          </button>
          {showSettled && <ul className="mt-1 flex flex-col gap-px">{settled.map(row)}</ul>}
        </section>
      )}
    </div>
  );
}
