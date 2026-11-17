import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useWorkspace } from "./workspace";

/**
 * A page belongs to the workspace it was opened in. When the window's workspace changes (the page's picker, a chat
 * opened in chat mode, the new chat's picker, a chat filed in another workspace), a page that shows one thing of a
 * workspace (a Review video, a Workshop session, an edit, a Media Library clip) leaves it for its tool's own page, which
 * lists the new workspace's. A page left open would show one workspace's thing and write with another's
 * (X-CT-Workspace): a session started from it would be filed in the new workspace, linked to the old one's final.
 * Pages of no one workspace (Home, Settings, a share link) stay. Each entry of the window's history keeps the workspace
 * it was opened in, so Back to another workspace's thing leaves it as well.
 */

/** The tools whose pages hold a workspace's things, by their address. */
const TOOLS = /^\/(review|workshop|editor|finals|library|design|enhance|record|clips|video-notes|documents|guides|instagram|analyzer|captions|stories)(?=\/|$)/;
/** Share links under those tools: what someone shared, in none of the person's workspaces. */
const SHARED = /^\/(clips\/f|library\/s)\//;

/** Where a page goes when the workspace changes: its tool's own page; null when it shows no one thing (it stays). */
export function leaveFor(path: string, search = ""): string | null {
  const tool = TOOLS.exec(path)?.[0];
  if (!tool || SHARED.test(path) || (path === tool && !search)) return null;
  return tool;
}

/** The workspace each entry of this window's history was opened in, by its key. */
const opened = new Map<string, string | null>();
/** The entry the browser is on now, as react-router keys it (history.state.key). Read from the browser, not from a
 *  render: react-router draws a move in a transition, so a workspace switch made with it can draw first, still on the
 *  old address. */
const entry = (): string => (window.history.state as { key?: string } | null)?.key ?? "default";

/** The workspace the page on screen was opened in (undefined before the workspaces are known). */
export const pageWorkspace = (): string | null | undefined => opened.get(entry());

/** A move made here, not a link followed: chat mode does not bring a hidden page back for it (AssistantDock). */
export const leftForWorkspace = (state: unknown): boolean => (state as { leftForWorkspace?: boolean } | null)?.leftForWorkspace === true;

/** For App, once: the page follows the window's workspace. */
export function usePageFollowsWorkspace(): void {
  const navigate = useNavigate();
  const { key } = useLocation();
  const ws = useWorkspace((s) => s.currentProjectId);
  const loaded = useWorkspace((s) => s.loaded);
  useEffect(() => {
    if (!loaded) return;
    const at = entry();
    if (!opened.has(at)) opened.set(at, ws);
    if (opened.get(at) === ws) return;
    const to = leaveFor(window.location.pathname, window.location.search);
    // a page of no one workspace stays, and shows the new one's from here on
    if (!to) return void opened.set(at, ws);
    navigate(to, { replace: true, state: { leftForWorkspace: true } });
  }, [key, ws, loaded, navigate]);
}
