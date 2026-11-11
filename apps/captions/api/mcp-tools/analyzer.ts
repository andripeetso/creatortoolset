import { InstagramUrlError, parseInstagramUrl } from "../lib/instagram/url";
import { YoutubeUrlError, parseYoutubeUrl } from "../lib/youtube/url";
import { pick, str, ToolError, when, type Args, type ToolContext, type ToolModule } from "./types";

// The Content Analyzer's saved posts (the library on /instagram): read one, find some by words, save new ones.
// Each tool is a thin client of api/instagram.ts's own routes.

/** How much of each text a call hands back; what was left out is named under `cut`. */
const DESCRIPTION_MAX = 6000;
const SAID_MAX = 20_000;
const ON_SCREEN_MAX = 2000;
const PIECE = 200;

/** A library id, bare or at the end of the app's own link to the post. */
const OWN_ID = /(?:^|\/(?:instagram|analyzer)\/)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,40}$/;
/** A link without its scheme, query or last slash, to compare a pasted link with a saved one. */
const bare = (u: unknown) => String(u ?? "").trim().split(/[?#]/)[0]!.replace(/^https?:\/\/(?:www\.|m\.)?/i, "").replace(/\/$/, "");

/** Where a saved post stands: being read now, failed, saved for later, or ready. */
const stateOf = (p: Args): string =>
  p.status === "processing" ? "reading" : p.status === "error" ? "failed" : ((p.jobs as Args[] | undefined) ?? []).some((j) => j.status === "pending") ? "not read yet" : "ready";

/** What every answer says of a post: its library id, link, who posted it, the kind, when, the counts. */
const head = (p: Args): Args => {
  const creator = String((p.creator as Args | undefined)?.username ?? "");
  return {
    id: p.id,
    link: p.url,
    ...(creator ? { creator: `@${creator}` } : {}),
    ...pick(p, ["kind", "platform"]),
    posted: when(p.takenAt),
    ...pick((p.counts ?? {}) as Args, ["plays", "likes", "comments"]),
  };
};

/** An Analyzer account of the user's by handle → its id (the routes take the id). */
const accountOf = async (handle: string, ctx: ToolContext) => {
  const name = handle.replace(/^@/, "").toLowerCase();
  const found = (await ctx.json<Args[]>(`/api/instagram/accounts?q=${encodeURIComponent(name)}`)).find((x) => String(x.username ?? "").toLowerCase() === name);
  if (!found) throw new ToolError(`No account of yours is called @${name}: instagram_add_account adds it.`);
  return String(found.id);
};

/** A saved post by its library id (or the app's link to it), its Instagram or YouTube link, or its shortcode. */
async function savedPost(given: string, ctx: ToolContext): Promise<Args> {
  if (!given) throw new ToolError("Give the post: its library id, its link or its shortcode.");
  const own = OWN_ID.exec(given.split(/[?#]/)[0]!);
  if (own) return ctx.json(`/api/instagram/${own[1]}`);
  let match: (p: Args) => boolean;
  if (SHORTCODE.test(given)) match = (p) => p.shortcode === given || p.shortcode === `yt-${given}` || p.id === given;
  else {
    try {
      const yt = parseYoutubeUrl(given);
      const ig = yt ? null : parseInstagramUrl(given);
      if (ig?.kind === "profile") throw new ToolError(`That is an account, not a post: instagram_posts lists @${ig.username}'s posts.`);
      const code = yt ? `yt-${yt.videoId}` : ig?.kind === "post" ? ig.shortcode : "";
      // reading a post replaces a share link's code with the post's own: such a post is found by the link it was saved with
      const link = ig ? bare(ig.kind === "share" ? ig.url : given) : "";
      match = (p) => (!!code && p.shortcode === code) || (!!link && [p.url, p.input].some((u) => bare(u) === link));
    } catch (e) {
      if (e instanceof InstagramUrlError || e instanceof YoutubeUrlError) throw new ToolError(`"${given}" is not a post's library id, link or shortcode.`);
      throw e;
    }
  }
  // ponytail: the whole library list is read to find one post; a lookup by shortcode on the route when libraries get big
  const found = (await ctx.json<Args[]>("/api/instagram?shelf=all")).find(match);
  if (!found) throw new ToolError("That post is not in the library: instagram_save saves it by its link.");
  return found;
}

export const analyzerTools: ToolModule = {
  defs: [
    {
      name: "instagram_post",
      description:
        "One post saved in the Analyzer's library, by its library id, link or shortcode: who posted it, when, the counts, the whole post description, the idea, and per slide what is said and the text on screen (subtitles = that text only repeats what is said). state says when it is still being read; a link that is not saved yet goes to instagram_save.",
      inputSchema: { type: "object", properties: { post: str }, required: ["post"] },
    },
    {
      name: "instagram_search",
      description:
        "Find saved posts in the Analyzer's library by words (any of them, in what is said, on screen, the post description, the idea or the comments), best match first, each with the id instagram_post reads. kind = reel, carousel or post; account = a handle.",
      inputSchema: { type: "object", properties: { q: str, kind: { type: "string", enum: ["reel", "carousel", "post"] }, account: str, limit: { type: "integer", description: "default 20, max 50" } }, required: ["q"] },
    },
    {
      name: "instagram_save",
      description:
        "Save posts to the Analyzer's library by their links (Instagram posts, reels and carousels, YouTube videos and Shorts), read on the user's own Apify key in a minute or two: instagram_post shows the state. read = stats (counts and post description), watch (default: plus what is said and the text on screen) or full (plus comments, tags and the idea); a link already saved is not read again unless again: true (new counts, and what it lacks).",
      inputSchema: { type: "object", properties: { links: { type: "array", items: str }, read: { type: "string", enum: ["stats", "watch", "full"] }, again: { type: "boolean" } }, required: ["links"] },
    },
  ],
  handlers: {
    instagram_post: async (a, ctx) => {
      const p = await savedPost(String(a.post ?? "").trim(), ctx);
      const cut: string[] = [];
      const fit = (text: string, max: number, what: string) => {
        if (text.length <= max) return text;
        cut.push(`${what}: the first ${max} of ${text.length} characters`);
        return text.slice(0, max);
      };
      let room = SAID_MAX;
      const slides: Args[] = [];
      for (const s of (p.slides as Args[] | undefined) ?? []) {
        const n = Number(s.index) + 1;
        const vision = (s.vision ?? {}) as Args;
        let said = "";
        if ((s.transcript as Args | undefined)?.status === "done") {
          const { words } = await ctx.json<{ words: Args[] }>(`/api/instagram/${p.id}/transcript/${s.index}`);
          said = fit(words.map((w) => w.text).join(" "), room, `said, slide ${n}`);
          room -= said.length;
        }
        const subtitles = vision.textKind === "captions";
        slides.push({
          slide: n,
          kind: s.kind,
          ...(s.durationS ? { seconds: Math.round(Number(s.durationS)) } : {}),
          ...(said ? { said } : {}),
          // subtitles say what the transcript says: left out when the transcript is here
          ...(vision.onScreenText && !(subtitles && said) ? { on_screen: fit(String(vision.onScreenText), ON_SCREEN_MAX, `on_screen, slide ${n}`) } : {}),
          ...(subtitles ? { subtitles: true } : {}),
        });
      }
      const state = stateOf(p);
      const problems = ((p.jobs as Args[] | undefined) ?? []).filter((j) => j.status === "error").map((j) => `${j.type}: ${j.error ?? "failed"}`);
      return {
        ...head(p),
        state,
        ...(state === "reading" ? pick(p, ["step"]) : {}),
        ...pick(p, ["error"]),
        app_link: `${ctx.origin}/instagram/${p.id}`,
        description: fit(String(p.caption ?? ""), DESCRIPTION_MAX, "description"),
        ...(p.idea ? { idea: pick(p.idea as Args, ["title", "takeaway"]) } : {}),
        slides,
        ...(problems.length ? { problems } : {}),
        ...(cut.length ? { cut } : {}),
        ...(state === "reading"
          ? { note: "Still being read: call instagram_post again in a minute." }
          : state === "not read yet"
            ? { note: "Saved for later and not read yet: instagram_save with its link reads it now." }
            : {}),
      };
    },
    instagram_search: async (a, ctx) => {
      const q = new URLSearchParams({ q: String(a.q ?? ""), limit: String(Math.max(1, Math.min(Number(a.limit) || 20, 50))) });
      if (a.kind) q.set("kind", String(a.kind));
      if (a.account) q.set("account", await accountOf(String(a.account), ctx));
      // as the page's search: the project the person is in
      const { currentProjectId } = await ctx.json<{ currentProjectId?: string | null }>("/api/workshop/workspace");
      if (currentProjectId) q.set("projectId", currentProjectId);
      const { hits } = await ctx.json<{ hits: Array<{ post: Args }> }>(`/api/instagram/find?${q}`);
      return {
        posts: hits.map(({ post }) => {
          const text = String(post.caption ?? "").replace(/\s+/g, " ").trim();
          const idea = (post.idea as Args | undefined)?.title;
          return { ...head(post), ...(idea ? { idea } : {}), description: text.length > PIECE ? `${text.slice(0, PIECE)}…` : text };
        }),
      };
    },
    instagram_save: async (a, ctx) => {
      const read = ["stats", "watch", "full"].includes(String(a.read)) ? a.read : "watch";
      // a link that is in the library already is not read again unless asked: each read is on the person's own credit
      const have: Args[] = [];
      const fresh: unknown[] = [];
      for (const link of [a.links].flat()) {
        const p = a.again === true || typeof link !== "string" ? null : await savedPost(link, ctx).catch(() => null);
        if (p) have.push(p);
        else fresh.push(link);
      }
      // what pasting links on the page sends; the route refuses in its own words (no link, no Apify key)
      const r = fresh.length || !have.length ? await ctx.json<{ posts: Args[]; errors?: Args[] }>("/api/instagram", "POST", { urls: fresh, recipe: { preset: read }, run: "now" }) : { posts: [] as Args[] };
      const row = (p: Args, already: boolean) => ({ id: p.id, link: p.url, state: stateOf(p), ...(already ? { already: true } : {}), app_link: `${ctx.origin}/instagram/${p.id}` });
      return {
        saved: [...have.map((p) => row(p, true)), ...r.posts.map((p) => row(p, !!p.existing))],
        ...(r.errors?.length ? { not_saved: r.errors } : {}),
        note: "Reading a post takes a minute or two: instagram_post shows its state.",
      };
    },
  },
  steps: {
    instagram_post: "Reading the Instagram post",
    instagram_search: "Searching your saved posts",
    instagram_save: "Saving to the Analyzer",
  },
  // a card only for a post this call put in the library: it opens the post (several: the library)
  work: (name, _a, r) => {
    const made = name === "instagram_save" ? ((r.saved as Args[] | undefined) ?? []).filter((p) => !p.already) : [];
    if (!made.length) return null;
    const one = made.length === 1;
    return {
      card: {
        id: `analyzer:${made[0]!.id}${one ? "" : `:${made.length}`}`,
        kind: "link",
        title: one ? "Saved post" : `${made.length} saved posts`,
        href: one ? `/instagram/${made[0]!.id}` : "/instagram",
        status: "done",
        detail: one ? bare(made[0]!.link) : "In the Analyzer",
      },
    };
  },
};
