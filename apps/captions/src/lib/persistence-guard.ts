import type { MouseEvent } from "react";

import { confirmDialog } from "./dialogs";
import { getProjectPersistenceStatus } from "./persistence-status";
import { useStudio } from "./store";

export function currentProjectPersistenceStatus() {
  const state = useStudio.getState();
  return getProjectPersistenceStatus({
    projectId: state.projectId,
    serverProjectReady: state.serverProjectReady,
    saveState: state.saveState,
    localSaveState: state.localSaveState,
    clips: state.clips,
  });
}

/**
 * Locally saved projects survive switching. Only interrupt navigation when
 * neither the browser database nor the server has the current work.
 */
export async function confirmDiscardUnsavedProject(action: string): Promise<boolean> {
  const status = currentProjectPersistenceStatus();
  if (status.workSafe) return true;
  return confirmDialog({
    title: `${action} anyway?`,
    body: `${status.message ?? "This project is not saved yet."} Unsaved changes may be lost.`,
    ok: action,
    danger: true,
  });
}

/** A link's onClick: the click goes through when the work is safe, else it asks first and then opens the link. */
export function guardLeaveLink(e: MouseEvent<HTMLAnchorElement>, action: string, go: (href: string) => void): void {
  if (currentProjectPersistenceStatus().workSafe) return;
  e.preventDefault();
  const href = e.currentTarget.getAttribute("href") ?? "/";
  void confirmDiscardUnsavedProject(action).then((yes) => yes && go(href));
}
