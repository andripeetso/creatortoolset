/**
 * The workspace this window is in, outside React's store (workspace.ts keeps it in step): every request says it
 * (sync.ts, the X-CT-Workspace header) and the saved copies are kept per workspace (local-cache.ts), so a list from one
 * workspace never paints in another. Its own tiny module so those two don't import the workspace store (a cycle).
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export const currentWorkspace = () => current;

export function setCurrentWorkspace(id: string | null) {
  if (id === current) return;
  current = id;
  for (const l of listeners) l();
}

export function onWorkspaceChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
