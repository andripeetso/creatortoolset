import { parseInstagramUrl } from "../lib/instagram/url";
import { parseYoutubeUrl } from "../lib/youtube/url";
import { PROJECT_COLORS } from "../lib/workshop/validate";
import { type Args, pick, str, ToolError, type ToolContext, type ToolModule } from "./types";

// The Content Workshop's tools that api/mcp.ts does not have yet: a session's sources, the current project, and a project's
// own settings.

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
      // description: the text under the post (the Analyzer stores it as the post's caption)
      return pick({ id: p.id, url: p.url, kind: p.kind, by: handle && `@${handle}`, description: String(p.caption ?? "").slice(0, 200), note: notes.get(p.id) }, ["id", "url", "kind", "by", "description", "note"]);
    }),
  };
}

/** A project's name, instructions, colour or language, as its form saves them; none named = the current project. */
async function projectUpdate(a: Args, ctx: ToolContext) {
  const id = a.project ? String(a.project) : (await ctx.json<{ currentProjectId: string | null }>("/api/workshop/workspace")).currentProjectId;
  if (!id) throw new ToolError("There is no project yet: give a project's id (workshop_projects lists them).");
  const body: Args = {};
  if (a.name !== undefined) body.name = a.name;
  // draft_from goes through the form's own Write it for me: the facts a writer needs and nothing on how to write, since
  // the writer takes the voice from the user's posts and rewrites
  const from = typeof a.draft_from === "string" ? a.draft_from.trim() : "";
  const was = from ? (await ctx.json<Args[]>("/api/workshop/projects")).find((p) => p.id === id) : undefined;
  const name = from && (a.name ?? was?.name);
  // a draft replaces the instructions whole: ones already written are asked about first (before the draft runs)
  if (from && String(was?.notes ?? "").trim()) await ctx.sure(`Replace "${String(was?.name ?? "the project")}"'s instructions with a new draft?`);
  const instructions = from ? (await ctx.json<{ notes: string }>("/api/workshop/projects/draft-notes", "POST", { name, text: from })).notes : a.instructions;
  // the instructions are one text: the old audience, voice and CTA fields are folded into it, as the form does
  if (instructions !== undefined) Object.assign(body, { notes: instructions, audience: "", voice: "", cta: "" });
  if (a.color !== undefined) body.color = a.color;
  if (a.language !== undefined) body.languages = a.language ? [a.language] : [];
  if (!Object.keys(body).length) throw new ToolError("Nothing to change: give name, instructions, draft_from, color or language.");
  const next = await ctx.json<Args>(`/api/workshop/projects/${encodeURIComponent(id)}`, "PATCH", body);
  return { project: pick({ ...next, instructions: next.notes }, ["id", "name", "instructions", "color", "languages"]) };
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
      description: "Switch the Workshop's current project (its id from workshop_projects): new sessions start in it, and the app opens in it next time. A window that is open stays in its own project.",
      inputSchema: { type: "object", properties: { project: str }, required: ["project"] },
    },
    {
      name: "workshop_project_update",
      description:
        'Change a Workshop project: its name, its instructions (the text always in its prompt; this replaces it whole, so read it with workshop_projects first and keep what holds: the user\'s own words, or draft_from = what they gave about the project, written into facts as the form\'s Write it for me does), its colour, or the language spoken in its videos (a two-letter code, "" = the person\'s own). Only what you give changes. No project = the current one.',
      inputSchema: {
        type: "object",
        properties: { project: str, name: str, instructions: str, draft_from: str, color: { type: "string", enum: [...PROJECT_COLORS] }, language: str },
      },
    },
  ],
  handlers: {
    workshop_sources: sources,
    workshop_project_update: projectUpdate,
    workshop_set_project: async (a, ctx) => {
      // the route reads an empty id as "no current project": never what switching means
      if (!a.project) throw new ToolError("Give the project's id: workshop_projects lists them.");
      const w = await ctx.json<{ currentProjectId: string | null; projects: Args[] }>("/api/workshop/workspace", "PATCH", { currentProjectId: a.project });
      return { current: pick(w.projects.find((p) => p.id === w.currentProjectId) ?? {}, ["id", "name"]) };
    },
  },
  steps: { workshop_sources: "Going through the session's sources", workshop_set_project: "Switching the project", workshop_project_update: "Changing the project" },
};
