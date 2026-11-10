import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/lib/workspace";

/**
 * Which projects a pack is in: "All my projects" (empty) or any of the person's projects, ticked one by one. The menu
 * stays open while ticking.
 */
export function ProjectsPicker({ value, onChange, disabled }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const projects = useWorkspace((s) => s.projects);
  const label =
    value.length === 0
      ? "All my projects"
      : value.length === 1
        ? (projects.find((p) => p.id === value[0])?.name ?? "1 project")
        : `${value.length} projects`;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label="Used in" className="h-7 max-w-56 justify-between gap-2 text-xs">
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuCheckboxItem
          checked={value.length === 0}
          onSelect={(e) => {
            e.preventDefault();
            onChange([]);
          }}
          className="text-xs"
        >
          All my projects
        </DropdownMenuCheckboxItem>
        {projects.length > 0 && <DropdownMenuSeparator />}
        {projects.map((p) => (
          <DropdownMenuCheckboxItem
            key={p.id}
            checked={value.includes(p.id)}
            onSelect={(e) => {
              e.preventDefault();
              toggle(p.id);
            }}
            className="text-xs"
          >
            <span className="truncate">{p.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
