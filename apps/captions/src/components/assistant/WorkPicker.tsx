import { useLocation, useNavigate } from "react-router";
import { ChevronDown, Loader2, PanelRight, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useChatMode, washTo } from "@/lib/chat-mode";
import { useRecentWork, workAt } from "@/lib/work";
import { ago } from "./ChatList";

/**
 * On the new-chat screen, under the question: what this chat is to work on. Pick one of the newest things in the works
 * (a video edit, a Workshop session) and its page opens beside the chat; the page is what says which one it is, so
 * moving on to another page changes it here too. Nothing picked is something new: only the chats, as the screen starts.
 */
export function WorkPicker() {
  const items = useRecentWork();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // the page stands beside the chat
  const beside = useChatMode((s) => s.page && !s.bare);
  if (!items?.length) return null;
  const picked = beside ? workAt(items, pathname) : undefined;
  // a page beside the chat that is none of the listed work (Home, an older edit): the chat works on that page
  const label = picked ? picked.title : beside ? "The page beside the chat" : "Something new";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="What this chat works on"
          className="flex h-7 max-w-[min(20rem,100%)] items-center gap-1.5 rounded-md border px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent data-[state=open]:bg-accent"
        >
          {picked ? <picked.icon className="size-3.5 shrink-0 text-[rgb(var(--violet-600))]" /> : beside ? <PanelRight className="size-3.5 shrink-0 text-muted-foreground" /> : <Plus className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-80">
        <DropdownMenuLabel className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">Carry on with</DropdownMenuLabel>
        {items.map((w) => (
          <DropdownMenuItem key={w.key} onSelect={() => w !== picked && navigate(w.to)}>
            <w.icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{w.title}</span>
            {w.busy && <Loader2 className="size-3 shrink-0 text-muted-foreground motion-safe:animate-spin" />}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {w.kind} · {ago(w.at)}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* nothing beside the chat (whatever page stands there now is put away): it is told what to make */}
        <DropdownMenuItem onSelect={() => beside && washTo({ bare: true })}>
          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">Something new</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
