import { Link } from "react-router";
import { Check, ChevronDown } from "lucide-react";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Header control: switch the account's current project. */
export function ProjectSwitcher({ onSelect }: { onSelect?: (id: string) => void } = {}) {
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
          title="Current project"
          className={`flex max-w-[14rem] items-center gap-1.5 h-7 rounded-md border px-2.5 text-xs text-zinc-200 outline-none hover:bg-zinc-900 data-[state=open]:bg-zinc-900 ${project ? PROJECT_COLORS[projectColor(project)].ring : "border-zinc-800"}`}
        >
          {/* the project's colour, so the current one shows at a glance */}
          <span className={`h-2 w-2 shrink-0 rounded-full ${project ? PROJECT_COLORS[projectColor(project)].dot : "bg-zinc-600"}`} />
          <span className="min-w-0 truncate">{project?.name ?? "No project"}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
          Current project
        </DropdownMenuLabel>
        {projects.length === 0 ? (
          <DropdownMenuItem asChild>
            <Link to="/projects">Create a project</Link>
          </DropdownMenuItem>
        ) : (
          projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => {
                if (p.id === currentProjectId) return;
                void select(p.id);
                onSelect?.(p.id);
              }}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(p)].dot}`} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === currentProjectId ? <Check className="h-3.5 w-3.5 text-violet-400" /> : null}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/projects">Manage projects…</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
