import { useLocation, useNavigate } from "react-router";
import { ArrowUpRight, ChevronDown, Loader2, PanelRight, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useChatMode, washTo } from "@/lib/chat-mode";
import { useRecentWork, workAt } from "@/lib/work";
import { currentProject, useWorkspace } from "@/lib/workspace";
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

/** What a new chat offers to ask, beyond what it is carrying on with. */
export const START_POOL = [
  "Where did I leave off?",
  "What can I finish right away?",
  "Find my next content idea",
  "What should I post this week?",
  "How did my last five posts do?",
  "Write three hooks for my next reel",
  "What's waiting for me in Review?",
];

/**
 * Three things to ask on a new chat's screen, a different three for each new chat (by its id, so they never change
 * under the pointer): the newest thing in the works first when there is one, the workspace's name in the idea.
 */
export function startSuggestions(seed: string, workspace?: string, newest?: string): string[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const pool = START_POOL.map((s) => (workspace && s === "Find my next content idea" ? `${s} for ${workspace}` : s));
  // a shuffle the seed decides
  for (let i = pool.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const first = newest?.trim() ? [`Carry on with "${newest.trim().length > 40 ? `${newest.trim().slice(0, 39)}…` : newest.trim()}"`] : [];
  return [...first, ...pool].slice(0, 3);
}

/** Under the box on a new chat's screen: the three, side by side in the middle; a press sends one. */
export function StartSuggestions({ seed, disabled, onPick }: { seed: string; disabled: boolean; onPick: (text: string) => void }) {
  const items = useRecentWork();
  const workspace = useWorkspace((s) => currentProject(s)?.name);
  // waits for the list of work, so the first chip does not swap in after the others
  if (items === null) return null;
  return (
    <div className="flex flex-wrap justify-center gap-2 pt-2">
      {startSuggestions(seed, workspace, items[0]?.title).map((s, i) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => onPick(s)}
          style={{ animationDelay: `${i * 90}ms` }}
          className="group flex max-w-full items-center gap-2 rounded-2xl border bg-background px-3.5 py-2 text-left text-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:shadow-md active:translate-y-0 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:fill-mode-both motion-safe:duration-300"
        >
          <span className="min-w-0 truncate">{s}</span>
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--tint)]" />
        </button>
      ))}
    </div>
  );
}
