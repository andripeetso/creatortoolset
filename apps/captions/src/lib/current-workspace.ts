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
  // the Mac app reads it to send a recording to this window's workspace (Shell.swift pageWorkspace)
  (globalThis as { ctWorkspace?: string | null }).ctWorkspace = id;
  for (const l of listeners) l();
}

export function onWorkspaceChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/**
 * Requests under a path that work in another workspace than the window's: a plug-in's settings page editing a workspace
 * where the plug-in is on while the window is in one where it is off (settings/PluginWorkspaces.tsx). Nothing else moves.
 */
const scoped = new Map<string, string>();

export function scopeRequests(prefix: string, workspace: string | null) {
  if (workspace) scoped.set(prefix, workspace);
  else scoped.delete(prefix);
}

/** The workspace a request to this URL works in: a scoped one, else the window's. */
export function workspaceFor(url: string): string | null {
  const path = typeof location !== "undefined" && url.startsWith(location.origin) ? url.slice(location.origin.length) : url;
  for (const [prefix, ws] of scoped) if (path.startsWith(prefix)) return ws;
  return current;
}
