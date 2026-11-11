import { parseInstagramUrl } from "../lib/instagram/url";
import { parseYoutubeUrl } from "../lib/youtube/url";
import { type Args, pick, str, ToolError, type ToolContext, type ToolModule } from "./types";

// The Content Workshop's tools that api/mcp.ts does not have yet: a session's sources, and the current project.

type Source = { postId: string; addedAt: number; note?: string };
type Post = Args & { id: string; shortcode?: string };

const refs = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The code a post or reel link carries, as the Analyzer keeps it ("" when the text is no such link). */
function codeOf(link: string): string {
  try {
    const video = parseYoutubeUrl(link);
    if (video) return `yt-${video.videoId}`;
    const parsed = parseInstagramUrl(link);
    return parsed.kind === "post" ? parsed.shortcode : "";
  } catch {
    return "";
  }
}

const notSaved = (ref: string) => new ToolError(`${ref} is not in the Analyzer's library: instagram_save saves it there, then add it here.`);

async function sources(a: Args, ctx: ToolContext) {
  if (!a.session) throw new ToolError("Give the session's id.");
  const at = `/api/workshop/sessions/${String(a.session)}`;
  const read = () => ctx.json<{ sources: Source[]; posts: Post[] }>(at);
  let session = await read();
  const add = refs(a.add);
  const remove = refs(a.remove);
  if (add.length || remove.length) {
    const out = new Set<string>();
    for (const ref of remove) {
      const code = UUID.test(ref) ? "" : codeOf(ref);
      const id = code ? session.posts.find((p) => p.shortcode === code)?.id : ref;
      if (!id || !session.sources.some((s) => s.postId === id)) throw new ToolError(`${ref} is not one of this session's sources.`);
      out.add(id);
    }
    // ponytail: a link is matched against the whole library list (no route finds a post by its link); a by-link route when libraries get big
    let library: Post[] | undefined;
    const kept = session.sources.filter((s) => !out.has(s.postId));
    for (const ref of add) {
      let id: string | undefined;
      if (UUID.test(ref)) id = await ctx.api(`/api/instagram/${ref}`).then(() => ref, () => undefined);
      else {
        const code = codeOf(ref);
        if (code) id = (library ??= await ctx.json<Post[]>("/api/instagram")).find((p) => p.shortcode === code)?.id;
      }
      if (!id) throw notSaved(ref);
      // the order the page keeps: what is there stays where it is, with its note; a new one goes to the end
      if (!kept.some((s) => s.postId === id)) kept.push({ postId: id, addedAt: Date.now() });
    }
    await ctx.api(at, "PATCH", { sources: kept });
    session = await read();
  }
  const notes = new Map(session.sources.map((s) => [s.postId, s.note]));
  return {
    sources: session.posts.map((p) => {
      const handle = String((p.creator as Args | undefined)?.username ?? "");
      return pick({ id: p.id, url: p.url, kind: p.kind, by: handle && `@${handle}`, caption: String(p.caption ?? "").slice(0, 200), note: notes.get(p.id) }, ["id", "url", "kind", "by", "caption", "note"]);
    }),
  };
}

export const workshopTools: ToolModule = {
  defs: [
    {
      name: "workshop_sources",
      description: "A session's sources: the posts from the Analyzer's library its writer reads. With only the session it lists them; add and remove take posts by library id or by their link.",
      inputSchema: { type: "object", properties: { session: str, add: { type: "array", items: str }, remove: { type: "array", items: str } }, required: ["session"] },
    },
    {
      name: "workshop_set_project",
      description: "Switch the Workshop's current project (new sessions start in it, and the app shows it): project is its id from workshop_projects.",
      inputSchema: { type: "object", properties: { project: str }, required: ["project"] },
    },
  ],
  handlers: {
    workshop_sources: sources,
    workshop_set_project: async (a, ctx) => {
      // the route reads an empty id as "no current project": never what switching means
      if (!a.project) throw new ToolError("Give the project's id: workshop_projects lists them.");
      const w = await ctx.json<{ currentProjectId: string | null; projects: Args[] }>("/api/workshop/workspace", "PATCH", { currentProjectId: a.project });
      return { current: pick(w.projects.find((p) => p.id === w.currentProjectId) ?? {}, ["id", "name"]) };
    },
  },
  steps: { workshop_sources: "Going through the session's sources", workshop_set_project: "Switching the project" },
};
