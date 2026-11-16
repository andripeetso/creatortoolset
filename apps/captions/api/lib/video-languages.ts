import type { SessionUser } from "../users";
import { projectOf } from "./project-of";
import { ownedProjects, sharedProjects } from "./workshop/workspace";

/**
 * The languages spoken in a workspace's videos (Settings → Workspace → Details), for whatever is transcribed from them:
 * captions, Media Library transcripts, Video Notes, an AI Editor edit that names none of its own. `workspace` is the id
 * the thing carries (a library's, an edit's, the one a request works in); a thing from before workspaces is the first
 * brand's (project-of.ts). Undefined when that workspace has none set, or the person has no workspace: the speech
 * engine then hears the person's own list (Settings → Voice → Spoken languages; speechFor and transcribeWav).
 */
export async function videoLanguages(username: string | null | undefined, workspace?: string | null): Promise<string[] | undefined> {
  if (!username) return undefined;
  const id = (await projectOf({ username } as SessionUser))?.(workspace ?? undefined);
  if (!id) return undefined;
  const p = [...(await ownedProjects(username)), ...(await sharedProjects(username))].find((x) => x.id === id);
  return p?.languages?.length ? p.languages : undefined;
}
