import { useState } from "react";
import { Link } from "react-router";
import { ProjectForm, type KeptFile } from "@/components/workshop/ProjectForm";
import { Button } from "@/components/ui/button";
import { addProjectFiles, patchProject, type ProjectFields } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { msg } from "./helpers";
import { Card, EmptyRow, LoadingRow, Section, saveFailed } from "./ui";
import { WorkspacePick, useSettingsWorkspace } from "./workspace-pick";

/**
 * Settings → Details (the Workspace group): one workspace's own settings, the same form the workspace switcher opens
 * (its name, colour, instructions, language and context files), for the workspace the selector shows.
 */
export function WorkspaceDetailsSection() {
  const w = useSettingsWorkspace("one");
  const loaded = useWorkspace((s) => s.loaded);
  const [busy, setBusy] = useState(false);
  const workspace = w.workspaces.find((p) => p.id === w.id);

  const save = async (fields: ProjectFields, files: KeptFile[]) => {
    if (!workspace) return;
    setBusy(true);
    try {
      await patchProject(workspace.id, fields);
      if (files.length) await addProjectFiles(workspace.id, files);
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <WorkspacePick mode="one" />
      {workspace ? (
        // keyed by the workspace: picking another one starts the form from that workspace's values
        <ProjectForm key={workspace.id} initial={workspace} busy={busy} onSave={save} />
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
