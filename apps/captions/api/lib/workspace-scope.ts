import type { MiddlewareHandler } from "hono";
import type { SessionUser } from "../users";
import { inProjectOf } from "./project-of";
import { getWorkspace, workspaceScope } from "./workshop/workspace";

/**
 * Each workspace is kept apart, every tool alike. The app sends the workspace its window is in with every request
 * (X-CT-Workspace, src/lib/sync.ts), and this runs the request inside it: getWorkspace(), resolveProjectId() and
 * currentProject() answer that workspace for everything the request does. A chat's own workspace (set by mcp.ts for its
 * tools) wins over the header. A request without the header (a phone, an API key, a <video src>) gets the stored one.
 */
export const WORKSPACE_HEADER = "x-ct-workspace";

export const inRequestWorkspace: MiddlewareHandler = (c, next) => {
  const id = c.req.header(WORKSPACE_HEADER);
  if (!id || workspaceScope.getStore() !== undefined) return next();
  return workspaceScope.run(id, next);
};

/** The workspace this request works in; undefined for a person with no workspace. */
export const currentWorkspaceId = async (user: SessionUser): Promise<string | undefined> =>
  (await getWorkspace(user)).currentProjectId ?? undefined;

/**
 * Which of the person's things are in the workspace this request works in, by the thing's own `projectId`: one made
 * before it had one belongs to the first brand (project-of.ts). null when nothing is kept apart (no workspace yet).
 * A view filter inside one account: a thing opened by its id still opens.
 */
export async function inCurrentWorkspace(user: SessionUser): Promise<((own?: string) => boolean) | null> {
  return inProjectOf(user, await currentWorkspaceId(user));
}
