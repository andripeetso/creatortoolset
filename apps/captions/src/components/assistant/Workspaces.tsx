import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, ChevronDown, ListFilter, Plus, Search } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isPhoneHub } from "@/lib/mobile";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

type Ws = { id: string; name: string; color?: string };

/** A workspace's two letters: the first of its first two words ("Tiny Acrobatics" TA), or its first two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const two = words.length > 1 ? `${[...words[0]!][0]}${[...words[1]!][0]}` : [...(words[0] ?? "?")].slice(0, 2).join("");
  return two.toUpperCase();
}

/** A workspace's mark: its two letters in its colour, on a pale square of that colour. */
export function WorkspaceBadge({ ws, className }: { ws: Ws; className?: string }) {
  const rgb = PROJECT_COLORS[projectColor(ws)].rgb;
  return (
    <span
      title={ws.name}
      aria-label={ws.name}
      style={{ color: `rgb(${rgb})`, background: `rgb(${rgb} / 0.14)` }}
      className={cn("inline-flex h-4 min-w-5 shrink-0 items-center justify-center rounded px-0.5 text-[9px] leading-none font-bold tracking-wide", className)}
    >
      {initials(ws.name)}
    </span>
  );
}

/** The person's workspaces by id, and whether there are enough of them for a chat's mark to tell them apart. */
export function useWorkspaceMarks(): { byId: Map<string, Ws>; many: boolean } {
  const projects = useWorkspace((s) => s.projects);
  return { byId: new Map(projects.map((p) => [p.id, p])), many: projects.length > 1 };
}

const FILTER_KEY = "ct-chats-workspace";
const readFilter = () => {
  try {
    return localStorage.getItem(FILTER_KEY);
  } catch {
    return null;
  }
};

/** The filter as it stands, outside React (a new chat starts in the workspace the list is narrowed to). */
export const chatFilterNow = (): string | null => readFilter();

/** Which workspace's chats the list shows (null: every workspace's), kept in this browser. */
export function useChatFilter(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState(readFilter);
  const projects = useWorkspace((s) => s.projects);
  const loaded = useWorkspace((s) => s.loaded);
  // a workspace that is gone shows them all again
  const live = id && loaded && !projects.some((p) => p.id === id) ? null : id;
  const set = (next: string | null) => {
    setId(next);
    try {
      if (next) localStorage.setItem(FILTER_KEY, next);
      else localStorage.removeItem(FILTER_KEY);
    } catch {
      /* blocked: it lasts this page */
    }
  };
  return [live, set];
}

/** A menu of workspaces with a box to find one by name, for a long list. `top`: what stands above them. */
function WorkspaceItems({ picked, onPick, top }: { picked: string | null; onPick: (id: string) => void; top?: ReactNode }) {
  const projects = useWorkspace((s) => s.projects);
  const [q, setQ] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  const shown = projects.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      {projects.length > 5 && (
        <label className="mb-1 flex h-8 items-center gap-2 border-b px-2 text-muted-foreground">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            ref={box}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            // the menu's own keys (type to jump, arrows) stay with the menu; letters go in the box
            onKeyDown={(e) => e.key.length === 1 && e.stopPropagation()}
            placeholder="Search workspaces…"
            aria-label="Search workspaces"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}
      {top}
      {shown.map((p) => (
        <DropdownMenuItem key={p.id} onSelect={() => onPick(p.id)}>
          <WorkspaceBadge ws={p} />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          {p.id === picked && <Check className="size-3.5 text-muted-foreground" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

const iconBtn = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/** The list's filter: every workspace's chats, or one workspace's. Tinted while one is picked. */
export function ChatFilterButton({ filter, onFilter }: { filter: string | null; onFilter: (id: string | null) => void }) {
  const { byId } = useWorkspaceMarks();
  const on = filter ? byId.get(filter) : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(iconBtn, on && "text-[var(--tint)]")} aria-label={on ? `Chats in ${on.name}` : "Show the chats of one workspace"} title={on ? `Only ${on.name}` : "Filter by workspace"}>
          <ListFilter className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <WorkspaceItems
          picked={filter}
          onPick={onFilter}
          top={
            <DropdownMenuItem onSelect={() => onFilter(null)}>
              <span className="inline-flex w-5 justify-center text-muted-foreground">∗</span>
              <span className="flex-1">All workspaces</span>
              {!filter && <Check className="size-3.5 text-muted-foreground" />}
            </DropdownMenuItem>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * On the new-chat screen: the workspace this chat is for. Its first message files the chat there for good, and its
 * tools work there whatever is open later. Picking one makes it the app's current one too, so the page beside shows it.
 */
export function NewChatWorkspace() {
  const loaded = useWorkspace((s) => s.loaded);
  const projects = useWorkspace((s) => s.projects);
  const current = useWorkspace(currentProject);
  const select = useWorkspace((s) => s.select);
  if (!loaded || !projects.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="The workspace this chat is for"
          className="flex h-7 max-w-[min(16rem,100%)] items-center gap-1.5 rounded-md border px-2 text-xs text-foreground outline-none transition-colors hover:bg-accent data-[state=open]:bg-accent"
        >
          {current && <WorkspaceBadge ws={current} />}
          <span className="min-w-0 truncate">{current?.name ?? "No workspace"}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-normal tracking-wider text-muted-foreground uppercase">Workspace</DropdownMenuLabel>
        <WorkspaceItems picked={current?.id ?? null} onPick={(id) => id !== current?.id && void select(id)} />
        <DropdownMenuSeparator />
        {!isPhoneHub() && (
          <DropdownMenuItem asChild>
            <Link to="/projects?add=1">
              <Plus className="size-3.5" /> New workspace…
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to="/projects">Manage workspaces…</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
