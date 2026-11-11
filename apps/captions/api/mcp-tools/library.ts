import type { AssetDetail, Collection, ShareCreated } from "../../contracts/library";
import { pick, str, ToolError, when, type Args, type ToolContext, type ToolModule } from "./types";

// The Media Library's tools for one clip: read it, change its words, file it in a folder, share it. Search, the folder
// list and bringing a folder in are in api/mcp.ts (media_search, media_folders, media_import_folder).

/** The most of a clip's spoken words media_get hands the AI at once (about 15 minutes of speech). */
const SAID_MAX = 12_000;

const enc = encodeURIComponent;
/** A clip of a source a plug-in adds (an external ref, api/library/refs.ts): the library keeps no file, folder or link of it. */
const fromSource = (id: string) => id.startsWith("ext_");
/** Finals has its own tool: its folder (the plain top-level one named Finals) is not the Media Library's to fill or share. */
const isFinals = (c: Collection) => c.kind === "manual" && c.parentId === null && c.name === "Finals";
const NOT_FINALS = "Finals is not a Media Library folder: a finished video goes there from Review or the AI Editor.";
const LOCAL_ONLY = "This link opens only on this computer and its network. For other people the server needs an address on the internet (PUBLIC_ORIGIN: the name of a tunnel that points at it).";

/** The account's own Media Library (the first one), the one media_search reads. */
const home = async (ctx: ToolContext): Promise<string> => {
  const lib = (await ctx.json<{ libraries: Array<{ id: string }> }>("/api/library")).libraries[0];
  if (!lib) throw new ToolError("This account has no Media Library yet.");
  return lib.id;
};
const foldersOf = async (ctx: ToolContext, lib: string) => (await ctx.json<{ collections: Collection[] }>(`/api/library/${enc(lib)}/collections`)).collections;
const idOf = (v: unknown, what: string): string => {
  const id = typeof v === "string" ? v.trim() : "";
  if (!id) throw new ToolError(`Give ${what} (media_search lists them).`);
  return id;
};
/**
 * One clip's own route, as the caller. A source's clip is answered by the plug-in that adds the source, when it
 * answers this path at all: when it does not, that is said plainly, not as a clip that is gone.
 */
const clip = (ctx: ToolContext, lib: string, id: string, method = "GET", body?: unknown) =>
  ctx.json<Partial<AssetDetail> & Args>(`/api/library/${enc(lib)}/assets/${enc(id)}`, method, body).catch((e: unknown) => {
    // only "not there": what the plug-in itself refuses with (its source cannot be reached, say) is passed on in its words
    if (!fromSource(id) || !(e instanceof ToolError) || !e.message.startsWith("Not found")) throw e;
    throw new ToolError(
      method === "GET"
        ? "This clip is from a source a plug-in adds, and that source has no more to read than media_search shows."
        : "This clip is from a source a plug-in adds: it is changed where that source keeps it, not here.",
    );
  });
const shown = (d: Partial<AssetDetail>) => (d.description?.text ? { description: d.description.text, description_by: d.description.source === "user" ? "the user" : "AI" } : {});
const appLink = (lib: string, id: string) => `/library?library=${enc(lib)}&asset=${enc(id)}`;

export const libraryTools: ToolModule = {
  defs: [
    {
      name: "media_get",
      description:
        "One Media Library clip by its id (media_search gives it): title, kind, length, when it was shot, roll (a or b, as the app sorted it) or finished, tags, its description in full, what is said in it (the first 12,000 characters), its folders and its link in the app. A clip from a plug-in's source comes with what that source has.",
      inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
    },
    {
      name: "media_update",
      description:
        'Change a clip\'s title, tags or description. tags is the whole list (a tag left out is removed); description "" removes the user\'s own, so the AI\'s shows again. A-roll and B-roll are sorted by the app, never set here.',
      inputSchema: { type: "object", properties: { id: str, title: str, tags: { type: "array", items: str }, description: str }, required: ["id"] },
    },
    {
      name: "media_add_to_folder",
      description: "Put clips (their ids) in a Media Library folder: folder = a plain folder's id (media_folders, kind manual), or name = a new folder to make first. Never Finals.",
      inputSchema: { type: "object", properties: { clips: { type: "array", items: str }, folder: str, name: str }, required: ["clips"] },
    },
    {
      name: "media_share",
      description:
        "A share link to one clip or one folder (its id) for people without an account: they can watch, and with download: true also download the files. days = how long the link lasts (default 7, max 90). The user is asked first. Make one only when the user asks for a link to share.",
      inputSchema: { type: "object", properties: { clip: str, folder: str, download: { type: "boolean" }, days: { type: "integer" } } },
    },
  ],
  handlers: {
    media_get: async (a, ctx) => {
      const id = idOf(a.id, "the clip's id");
      const lib = await home(ctx);
      const d = await clip(ctx, lib, id);
      const all = (d.transcript?.segments ?? []).map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
      const hearing = (d.jobs ?? []).find((j) => j.kind === "transcribe" && j.state !== "done");
      // a source's clip opens where its plug-in says (link in its answer), not on the library's page
      const link = fromSource(id) ? (typeof d.link === "string" ? d.link : undefined) : appLink(lib, id);
      return {
        ...pick(d, ["id", "versionId", "title", "kind", "state", "durationS", "roll", "finished", "tags"]),
        ...(d.capturedAt ? { captured: when(d.capturedAt) } : {}),
        ...shown(d),
        ...(all ? { transcript: all.length > SAID_MAX ? `${all.slice(0, SAID_MAX)} … (cut: ${all.length.toLocaleString("en-US")} characters in all; the page has the rest)` : all } : {}),
        ...(!all && hearing ? { note: `No transcript yet: its transcript is ${hearing.state === "needs_key" ? "waiting" : hearing.state}${hearing.error ? ` (${hearing.error})` : ""}.` } : {}),
        ...(d.collections?.length ? { folders: d.collections.map((c) => ({ id: c.id, name: c.name })) } : {}),
        ...(link ? { link } : {}),
      };
    },
    media_update: async (a, ctx) => {
      const id = idOf(a.id, "the clip's id");
      // by hand, not pick(): "" and [] are answers here (remove my description, no tags)
      const body: Args = {};
      for (const k of ["title", "tags", "description"]) if (a[k] !== undefined && a[k] !== null) body[k] = a[k];
      if (!Object.keys(body).length) throw new ToolError("Nothing to change: give a title, tags or a description.");
      const lib = await home(ctx);
      const d = await clip(ctx, lib, id, "PATCH", body);
      return { ...pick(d, ["id", "title"]), tags: d.tags ?? [], ...shown(d), link: appLink(lib, id) };
    },
    media_add_to_folder: async (a, ctx) => {
      // everything is checked before a folder is made, so a refusal leaves no empty folder behind
      const clips = [...new Set((Array.isArray(a.clips) ? a.clips : []).map((x) => String(x).trim()).filter(Boolean))];
      if (!clips.length) throw new ToolError("Give clips: the ids of the clips to file (media_search lists them).");
      if (clips.some(fromSource)) throw new ToolError("A clip from a source a plug-in adds is not the Library's to file: leave those out.");
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!a.folder === !name) throw new ToolError("Give folder (the id of a folder there is: media_folders) or name (a new folder to make), one of the two.");
      if (/^finals$/i.test(name)) throw new ToolError(NOT_FINALS);
      const lib = await home(ctx);
      const at = `/api/library/${enc(lib)}/collections`;
      let folder: Pick<Collection, "id" | "name">;
      if (name) folder = await ctx.json<Collection>(at, "POST", { name });
      else {
        const found = (await foldersOf(ctx, lib)).find((c) => c.id === a.folder);
        if (!found) throw new ToolError("No folder has that id: media_folders lists them.");
        if (isFinals(found)) throw new ToolError(NOT_FINALS);
        // a smart folder lists what its search finds; the A-roll one would file a clip as A-roll, and the app sorts that
        if (found.kind !== "manual") throw new ToolError(`"${found.name}" fills itself from a search: pick a plain folder (kind manual), or give name to make one.`);
        folder = found;
      }
      const { added } = await ctx.json<{ added: number }>(`${at}/${enc(folder.id)}/items`, "POST", { assetIds: clips });
      return {
        folder: folder.id,
        name: folder.name,
        ...(name ? { made: true } : {}),
        added,
        ...(added < clips.length ? { note: `${clips.length - added} of the ${clips.length} were in it already, or are not clips of this library.` } : {}),
      };
    },
    media_share: async (a, ctx) => {
      if (!a.clip === !a.folder) throw new ToolError("Give clip (a clip's id) or folder (a folder's id), one of the two.");
      const days = a.days == null ? 7 : Number(a.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new ToolError("days is a whole number from 1 to 90.");
      const lib = await home(ctx);
      let what: string;
      let target: { kind: "asset" | "collection"; id: string };
      if (a.clip) {
        target = { kind: "asset", id: idOf(a.clip, "the clip's id") };
        if (fromSource(target.id)) throw new ToolError("A clip from a source a plug-in adds is shared where that source keeps it, not here.");
        what = `the clip "${String((await clip(ctx, lib, target.id)).title ?? "").slice(0, 80)}"`;
      } else {
        const found = (await foldersOf(ctx, lib)).find((c) => c.id === a.folder);
        if (!found) throw new ToolError("No folder has that id: media_folders lists them.");
        if (isFinals(found)) throw new ToolError("Finals is not a Media Library folder: share a clip, or one of the library's own folders.");
        target = { kind: "collection", id: found.id };
        what = `the folder "${found.name}"${found.count === undefined ? "" : ` (${found.count} ${found.count === 1 ? "file" : "files"})`}`;
      }
      const download = a.download === true;
      // a server on this computer with no address on the internet: the link opens here only
      const here = process.env.CT_LOCAL === "1" && !process.env.PUBLIC_ORIGIN;
      const can = `Anyone with the link can watch${download ? " and download the files" : ""}, no account needed, for ${days} ${days === 1 ? "day" : "days"}`;
      await ctx.sure(`Share ${what}? ${can}.${here ? " The link opens only on this computer and its network." : ""}`);
      const made = await ctx.json<ShareCreated>(`/api/library/${enc(lib)}/shares`, "POST", {
        target,
        scope: download ? "download" : "view",
        expiresInDays: days,
      });
      // the link first: what the person reads on the Yes card is the start of this answer
      return { share_link: `${ctx.origin}${made.url}`, ...(here ? { note: LOCAL_ONLY } : {}), shared: what, viewers: can, expires: `${when(made.expiresAt)} UTC` };
    },
  },
  steps: {
    media_get: "Reading the clip",
    media_update: "Updating the clip",
    media_add_to_folder: "Filing clips in a folder",
    media_share: "Making a share link",
  },
};
