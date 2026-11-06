import { isGuest, useAuth } from "./auth";
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
    guest: isGuest(useAuth.getState().me),
  });
}

/**
 * Locally saved projects survive switching. Only interrupt navigation when
 * neither the browser database nor the server has the current work.
 */
export function confirmDiscardUnsavedProject(action: string): boolean {
  const status = currentProjectPersistenceStatus();
  if (status.workSafe) return true;
  return window.confirm(
    `${status.badge}\n\n${status.message ?? "This project is not saved yet."}\n\n${action} anyway? Unsaved changes may be lost.`,
  );
}
