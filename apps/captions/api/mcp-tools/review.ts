import { ToolError, clock, pick, str, when, type Args, type ToolContext, type ToolModule } from "./types";

// Review's writes for the assistant: a comment or a reply, a video's name, folder and finished mark, the folders, the
// trash. Reading, resolving, the approval and the share link are api/mcp.ts's own tools.

/** A review link or id → its API path (the user's own, a share link's, or a shared folder's video). */
export function reviewPath(link: string, origin: string): string {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const p = (() => {
    try {
      return new URL(link, origin).pathname;
    } catch {
      return link;
    }
  })();
  for (const [re, api] of [
    [new RegExp(`^/?(${uuid})/?$`, "i"), (a: string[]) => `/api/review/assets/${a[0]}`],
    [new RegExp(`/review/(${uuid})`, "i"), (a: string[]) => `/api/review/assets/${a[0]}`],
    [new RegExp(`/r/(${uuid})`, "i"), (a: string[]) => `/api/review/s/${a[0]}`],
    [new RegExp(`/rp/(${uuid})/(${uuid})`, "i"), (a: string[]) => `/api/review/p/${a[0]}/a/${a[1]}`],
  ] as const) {
    const m = re.exec(p) ?? re.exec(link);
    if (m) return api(m.slice(1));
  }
  throw new ToolError(`That isn't a review link: expected ${origin}/review/<id>, /r/<token> or /rp/<token>/<id>.`);
}

/** The page that opens an API path: the owner's /review/<id>, or the share link's own page. */
export const reviewPage = (path: string): string =>
  path.replace(/^\/api\/review\/assets\//, "/review/").replace(/^\/api\/review\/s\//, "/r/").replace(/^\/api\/review\/p\/([^/]+)\/a\//, "/rp/$1/");

/**
 * The video behind a link and where the caller writes on it: the owner's routes when the video is theirs (also when
 * they gave its share link), else the link's own routes, as a reviewer (manage: false). A reviewer may comment,
 * resolve what they wrote, and approve or ask for changes; the rest is the owner's.
 */
export async function reviewOf(ctx: Pick<ToolContext, "json" | "origin">, link: unknown) {
  const at = reviewPath(String(link ?? ""), ctx.origin);
  const seen = await ctx.json(at);
  const own = `/api/review/assets/${(seen.asset as Args).id}`;
  const mine = seen.manage ? seen : await ctx.json(own).catch(() => null);
  const view = mine ?? seen;
  return { path: mine ? own : at, manage: !!mine, asset: view.asset as Args, comments: (view.comments as Args[] | undefined) ?? [] };
}

/** The caller's own video, or the refusal in plain words when the link is a reviewer's. */
async function ownOf(ctx: ToolContext, link: unknown, what: string) {
  const r = await reviewOf(ctx, link);
  if (!r.manage) throw new ToolError(`That video is someone else's: only its owner can ${what}.`);
  return r;
}

const same = (x: unknown, y: string) => String(x).trim().toLowerCase() === y.toLowerCase();
const link = { type: "string", description: "the video's link or id" };

export const reviewTools: ToolModule = {
  defs: [
    {
      name: "review_comment",
      description: "Write a comment on a Review video (link: its link or id, or a share link), or reply to one (reply_to: that comment's id). version defaults to the newest; at and end (seconds) pin it to a moment or a range.",
      inputSchema: { type: "object", properties: { link: str, text: str, version: { type: "integer" }, at: { type: "number" }, end: { type: "number" }, reply_to: str }, required: ["link", "text"] },
    },
    {
      name: "review_update",
      description: 'Rename a Review video (name), file it in a folder (folder: its name or id, as review_folders lists; "none" takes it out), or mark it finished or not (finished).',
      inputSchema: { type: "object", properties: { link, name: str, folder: str, finished: { type: "boolean" } }, required: ["link"] },
    },
    { name: "review_folders", description: "Review's folders: id and name. With name, makes that folder (or finds the one already called that).", inputSchema: { type: "object", properties: { name: str } } },
    {
      name: "review_trash",
      description: "Move a Review video to the trash, or bring it back with restore: true. With no link, lists what is in the trash.",
      inputSchema: { type: "object", properties: { link, restore: { type: "boolean" } } },
    },
  ],
  handlers: {
    review_comment: async (a, ctx) => {
      const r = await reviewOf(ctx, a.link);
      const parent = a.reply_to == null ? undefined : r.comments.find((c) => c.id === a.reply_to && !c.parentId);
      if (a.reply_to != null && !parent) throw new ToolError("No comment with that id on this video: get_review lists them.");
      const versions = (r.asset.versions as Args[] | undefined) ?? [];
      // a reply sits on its comment's version, where the page shows the thread
      const n = parent ? parent.version : a.version != null ? Number(a.version) : versions.at(-1)?.n;
      if (!versions.some((v) => v.n === n)) throw new ToolError(`This video has no version ${String(n)}.`);
      const cm = await ctx.json(`${r.path}/comments`, "POST", { version: n, text: a.text, ...(parent ? { parentId: parent.id } : { t: a.at, tEnd: a.end }) });
      return {
        ...pick(cm, ["id", "version", "author"]),
        video: r.asset.name,
        ...(typeof cm.t === "number" ? { at: clock(cm.t) + (typeof cm.tEnd === "number" ? `–${clock(cm.tEnd)}` : "") } : {}),
        ...(parent ? { reply_to: parent.id } : {}),
        // the page opens a thread by its first comment
        page: `${reviewPage(r.path)}?v=${String(cm.version)}&c=${String(parent?.id ?? cm.id)}`,
      };
    },
    review_update: async (a, ctx) => {
      const body: Args = { ...(a.name ? { name: a.name } : {}), ...(typeof a.finished === "boolean" ? { finished: a.finished } : {}) };
      if (!Object.keys(body).length && a.folder == null) throw new ToolError("Nothing to change: give a name, a folder or finished.");
      const r = await ownOf(ctx, a.link, a.name ? "rename it" : a.folder != null ? "move it" : "mark it finished");
      let folder: Args | undefined;
      if (a.folder != null) {
        const want = String(a.folder).trim();
        const out = !want || same(want, "none");
        // looked up here so a folder that isn't there is refused as a folder, not as a video nobody found
        if (!out) folder = (await ctx.json<Args[]>("/api/review/projects")).find((p) => p.id === want || same(p.name, want));
        if (!out && !folder) throw new ToolError(`No folder called "${want}": review_folders lists them, and makes one when given a name.`);
        // null takes it out of its folder
        body.projectId = folder?.id ?? null;
      }
      const m = await ctx.json(r.path, "PATCH", body);
      return {
        ...pick(m, ["id", "name"]),
        ...(a.folder != null ? { folder: folder?.name ?? "none" } : {}),
        finished: !!(m.done as Args | null)?.finished,
        link: `${ctx.origin}/review/${String(m.id)}`,
      };
    },
    review_folders: async (a, ctx) => {
      const folders = (await ctx.json<Args[]>("/api/review/projects")).map((p) => pick(p, ["id", "name"]));
      const name = String(a.name ?? "").trim();
      if (!name) return { folders };
      const had = folders.find((p) => same(p.name, name));
      return had ? { ...had, made: false } : { ...pick(await ctx.json("/api/review/projects", "POST", { name }), ["id", "name"]), made: true };
    },
    review_trash: async (a, ctx) => {
      if (!a.link) return { trash: (await ctx.json<Args[]>("/api/review/trash")).map((m) => ({ id: m.id, name: m.name, deleted: when(m.deletedAt) })) };
      if (a.restore === true) {
        const id = /^\/api\/review\/assets\/(.+)$/.exec(reviewPath(String(a.link), ctx.origin))?.[1];
        if (!id) throw new ToolError("Give the video's id or its /review/ link: a share link is off while its video is in the trash.");
        const m = await ctx.json(`/api/review/trash/${id}/restore`, "POST").catch((e: unknown) => {
          throw e instanceof ToolError && e.message.startsWith("Not found") ? new ToolError("That video isn't in this account's trash: review_trash with no link lists what is.") : e;
        });
        return { ...pick(m, ["id", "name"]), restored: true, link: `${ctx.origin}/review/${String(m.id)}` };
      }
      const r = await ownOf(ctx, a.link, "move it to the trash");
      await ctx.sure(`Move the Review video "${String(r.asset.name)}" to the trash?`);
      await ctx.json(r.path, "DELETE");
      return { ...pick(r.asset, ["id", "name"]), trashed: true };
    },
  },
  // one line per tool, so each is true whatever the call does (review_trash also lists and restores)
  steps: {
    review_comment: "Writing a comment",
    review_update: "Updating the video in Review",
    review_folders: "Looking at Review's folders",
    review_trash: "Working in Review's trash",
  },
  // a comment's card opens the video at that comment
  work: (name, _a, r) =>
    name === "review_comment" && r.id
      ? { card: { id: `review:comment:${String(r.id)}`, kind: "review", title: String(r.video ?? "Review"), href: String(r.page), status: "done", detail: `${r.reply_to ? "Reply" : "Comment"} added${r.at ? ` at ${String(r.at)}` : ""}` } }
      : null,
};
