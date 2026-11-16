import { useMemo } from "react";
import { Link } from "react-router";
import { ProjectForm, type KeptFile } from "@/components/workshop/ProjectForm";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth";
import { addProjectFiles, patchProject, type ProjectFields } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { Card, EmptyRow, LoadingRow, Section } from "./ui";
import { WorkspacePick, useSettingsWorkspace } from "./workspace-pick";

/** The workspaces whose settings are the person's to change: their own. One the team's owner gave them is used, never changed. */
export function useOwnWorkspaces(): string[] {
  const all = useWorkspace((s) => s.projects);
  const me = useMe()?.username;
  return useMemo(() => all.filter((p) => !me || p.owner === me).map((p) => p.id), [all, me]);
}

/**
 * Settings → Details (the Workspace group): one workspace's own settings, the same form the workspace switcher opens
 * (its name, colour, instructions, language and context files), for the workspace the selector shows.
 */
export function WorkspaceDetailsSection() {
  const own = useOwnWorkspaces();
  const w = useSettingsWorkspace("one", own);
  const loaded = useWorkspace((s) => s.loaded);
  const workspace = w.workspaces.find((p) => p.id === w.id);

  // a failed save is said by the form itself, under its rows
  const save = async (fields: ProjectFields, files: KeptFile[]) => {
    if (!workspace) return;
    await patchProject(workspace.id, fields);
    if (files.length) await addProjectFiles(workspace.id, files);
  };

  return (
    <>
      <WorkspacePick mode="one" only={own} />
      {workspace ? (
        // keyed by the workspace: picking another one starts the form from that workspace's values
        <ProjectForm key={workspace.id} settings initial={workspace} busy={false} onSave={save} />
      ) : (
        <Section
          title="Details"
          action={
            loaded && (
              <Button asChild size="sm" variant="outline">
                <Link to="/projects?add=1">New workspace</Link>
              </Button>
            )
          }
        >
          <Card>{loaded ? <EmptyRow title="No workspace" /> : <LoadingRow />}</Card>
        </Section>
      )}
    </>
  );
}
