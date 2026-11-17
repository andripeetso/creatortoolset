import { Link } from "react-router";
import { Check, ChevronDown, Plus } from "lucide-react";
import { isPhoneHub } from "@/lib/mobile";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Header control: switch the window's workspace. A page that shows one thing of the workspace it leaves goes to its
 * tool's own page by itself (lib/page-workspace.ts).
 */
export function ProjectSwitcher() {
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);
  const loaded = useWorkspace((s) => s.loaded);
  const select = useWorkspace((s) => s.select);
  const project = useWorkspace(currentProject);

  if (!loaded) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-project-switcher=""
          title="Current workspace"
          className={`flex max-w-[min(14rem,100%)] items-center gap-1.5 h-7 rounded-md border px-2.5 text-xs text-zinc-200 outline-none hover:bg-zinc-900 data-[state=open]:bg-zinc-900 ${project ? PROJECT_COLORS[projectColor(project)].ring : "border-zinc-800"}`}
        >
          {/* the project's colour, so the current one shows at a glance */}
          <span className={`h-2 w-2 shrink-0 rounded-full ${project ? PROJECT_COLORS[projectColor(project)].dot : "bg-zinc-600"}`} />
          <span className="min-w-0 truncate">{project?.name ?? "No workspace"}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
          Current workspace
        </DropdownMenuLabel>
        {projects.length === 0 ? (
          <DropdownMenuItem asChild>
            <Link to="/projects?add=1">New workspace…</Link>
          </DropdownMenuItem>
        ) : (
          projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => {
                if (p.id !== currentProjectId) void select(p.id);
              }}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(p)].dot}`} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === currentProjectId ? <Check className="h-3.5 w-3.5 text-violet-400" /> : null}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        {/* start a new one from here: it opens the form, and a new project is the one picked. Not on a phone, where
            projects are made on the computer */}
        {projects.length > 0 && !isPhoneHub() && (
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
