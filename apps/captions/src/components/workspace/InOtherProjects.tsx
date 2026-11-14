import { Fragment } from "react";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/**
 * One line under a list kept to the project on hand (lib/by-project.ts): what the person's other projects have of it,
 * each with its name ("12 edits in Tiny Acrobatics"), and a press switches to that project. So nothing of theirs looks
 * lost, and a project with nothing of its own yet says where the rest is. Nothing when the other projects have none.
 */
export function InOtherProjects({ elsewhere, one, many, className }: { elsewhere: Array<{ projectId: string; count: number }>; one: string; many: string; className?: string }) {
  const projects = useWorkspace((s) => s.projects);
  const select = useWorkspace((s) => s.select);
  const named = elsewhere.flatMap((e) => {
    const p = projects.find((x) => x.id === e.projectId);
    return p ? [{ ...e, name: p.name }] : [];
  });
  if (!named.length) return null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {named.map((e, i) => (
        <Fragment key={e.projectId}>
          {i > 0 && <span aria-hidden> · </span>}
          <button type="button" onClick={() => void select(e.projectId)} className="underline-offset-2 hover:text-foreground hover:underline" title={`Switch to ${e.name}`}>
            {e.count} {e.count === 1 ? one : many} in <span className="font-medium">{e.name}</span>
          </button>
        </Fragment>
      ))}
    </p>
  );
}
