import type { AnimationStyle, AnimationStylesView, EditingStyle, EditingStylesView, StyleProposal } from "../../contracts/editor-styles";
import { briefNotTyped, type StyleKind } from "../editor/animation-styles";
import { WORDS_FROM } from "../editor/own-words";
import { stylesView } from "../editor/styles";
import { ToolError, pick, str, type Args, type ToolContext, type ToolModule } from "./types";

// The AI Editor's editing styles for the assistant (contracts/editor-styles.ts): make or change one, and put one on an
// edit. Listed through editorTools (editor.ts), so an install whose AI Editor is a plug-in's has neither.
//
// A style's notes go into the script prompt of every later edit in that style, so they are the person's words and
// nothing else: the routes keep notes sent from a reply only when the person typed them in that chat (api/editor/
// routes.ts). The notes never come back through these tools either: a style can be one somebody else published, and
// its text is not for an AI that has tools on the person's computer. On a change, notes add a line and never replace:
// what the person wrote before stays until they change it on the style's sheet.
//
// An animation style (the look of an edit's animated cards) is made the same way: its brief is the person's words by
// the same check, and its pictures are ones they sent in the chat, found by the reply itself and never by a path. A
// brief that is not their words does not stop the style: it is made without one, and its sheet opens for them to
// write it there. After a save in the app's own chat the style's sheet opens (ctx.open), so they see what was made.
// Words taken from a long text they pasted with the message (own-words.ts) are theirs too: the answer then says so,
// for the AI to tell them in a line.

/** editor_style_use is listed only for an account that has a style (api/mcp.ts, tools/list). */
export const hasStyle = (username: string): boolean => stylesView(username).styles.length > 0;

/** What the tool calls a field → the route's name for it. The notes are sent apart. */
const FIELDS = { name: "name", versions: "versions", target_s: "targetS", pace: "pace", punch: "punch", passes: "passes" } as const;

const styles = async (ctx: ToolContext) => (await ctx.json<EditingStylesView>("/api/editor/styles")).styles;
const out = (s: EditingStyle) => ({ id: s.id, name: s.name, versions: s.versions, target_s: s.targetS, pace: s.pace, punch: s.punch, size: s.size ? `${s.size.w}x${s.size.h}` : "footage", has_notes: !!s.notes, has_playbook: !!s.playbook });
/** The tool's size, "1080x1920" or "footage" (the footage's own) → the route's. */
const sizeOf = (v: unknown) => (v === "footage" ? null : { w: Number(String(v).split("x")[0]), h: Number(String(v).split("x")[1]) });
const sheet = (ctx: ToolContext) => `${ctx.origin}/editor?tab=styles`;
/** A save through a style's route: what it answers, and whether the style's words were taken from the person's pasted text. */
async function saved<S>(ctx: ToolContext, route: string, method: string, body: Args): Promise<{ style: S; pasted: boolean }> {
  const res = await ctx.api(route, method, body);
  return { style: (await res.json()) as S, pasted: res.headers.get(WORDS_FROM) === "pasted" };
}
const FROM_PASTE = (what: string) => `${what} taken word for word from the text the user pasted: tell them so in one short line.`;
/** A style's own sheet: its tab with the style named, which the page opens (src/pages/EditorPage.tsx; a carousel style's: src/pages/DesignsPage.tsx). */
const sheetOf = (tab: "styles" | "animation" | "carousel", id: string) => (tab === "carousel" ? `/design?tab=styles&style=${id}` : `/editor?tab=${tab}&style=${id}`);

/** One of the person's styles by its id, or by its name in any case. `kind`: "editing" or "animation", for the words of a miss. */
export function one<S extends { id: string; name: string }>(all: S[], key: unknown, kind = "editing", maker = "editor_style_save"): S {
  const k = String(key ?? "").trim().toLowerCase();
  const hits = all.filter((s) => s.id === k);
  const found = hits.length ? hits : all.filter((s) => s.name.toLowerCase() === k);
  if (found.length === 1) return found[0]!;
  if (!all.length) throw new ToolError(`The user has no ${kind} style yet: ${maker} makes one.`);
  throw new ToolError(`${found.length ? "Several styles have that name: give the id" : "No style has that id or name"}. The user's styles: ${all.map((s) => `${s.name} (${s.id})`).join(", ")}.`);
}

/** animation_style_save, and the Designer's carousel_style_save (designs.ts): a style of that kind made or changed, its sheet opened. */
export const saveStyle = (kind: StyleKind) => async (a: Args, ctx: ToolContext) => {
  const at = kind === "carousel" ? "/api/designs/styles" : "/api/editor/animation-styles";
  const name = a.name == null ? undefined : String(a.name);
  const brief = typeof a.brief === "string" ? a.brief.trim() : "";
  const pictures = a.pictures == null ? 0 : Number(a.pictures);
  const video = typeof a.from_video === "string" && a.from_video.trim() ? a.from_video.trim() : "";
  const was = a.id == null ? null : one((await ctx.json<AnimationStylesView>(at)).styles, a.id, kind, `${kind}_style_save`);
  if (!was && !name) throw new ToolError("Give the new style a name.");
  if (was && name === undefined && !brief && !pictures && !video) throw new ToolError("Nothing to change: give name, brief, pictures or from_video.");
  let pasted = false;
  const save = async (body: Args) => {
    const r = await saved<AnimationStyle>(ctx, was ? `${at}/${was.id}` : at, was ? "PUT" : "POST", body);
    pasted ||= r.pasted;
    return r.style;
  };
  // a brief that is not the person's words never stops the style: the rest is saved and they write it on its sheet.
  // On a change the words are added under the brief it has and never replace it
  let unsaid = false;
  let s = await save({ ...(name !== undefined ? { name } : {}), ...(brief ? { [was ? "addBrief" : "brief"]: brief } : {}) }).catch((e: unknown) => {
    if (!(brief && e instanceof ToolError && e.message === briefNotTyped(kind))) throw e;
    unsaid = true;
    return was && name === undefined ? was : save({ name });
  });
  let added: number | undefined;
  let full = false;
  if (pictures) {
    const r = await ctx.json<{ style: AnimationStyle; added: number; full?: true }>(`${at}/${s.id}/pictures/chat`, "POST", { newest: pictures });
    ({ style: s, added } = r);
    full = !!r.full;
  }
  // stills of a reference video (a library version id): each moment once; a computer still making some says so
  let fromVideo: { added: number; waiting?: string; full?: true } | undefined;
  if (video) {
    const r = await ctx.json<{ style: AnimationStyle; added: number; waiting?: string; full?: true }>(`${at}/${s.id}/pictures/video`, "POST", { clip: video });
    ({ style: s } = r);
    fromVideo = { added: r.added, ...(r.waiting ? { waiting: r.waiting } : {}), ...(r.full ? { full: r.full } : {}) };
  }
  await ctx.open?.(sheetOf(kind, s.id));
  const notes = [
    unsaid ? "The description was not saved: it is not a whole phrase the user typed in this chat, or a passage of a text they pasted with this message. They write or paste it on the style's sheet." : "",
    pasted ? FROM_PASTE("The description was") : "",
    added !== undefined && added < pictures ? (full ? "The style holds all the pictures it keeps: the rest were not added." : "Fewer pictures were added than asked: the others are already in the style, are not in this chat, or could not be read.") : "",
    fromVideo?.waiting ? `Stills of the video are still being made (${fromVideo.waiting}): call again with the same from_video later to add the rest.` : "",
    fromVideo?.full ? "The style holds all the pictures it keeps: not every still of the video went in." : "",
    ctx.open ? "Its sheet is open for the user." : "",
  ].filter(Boolean);
  return {
    id: s.id,
    name: s.name,
    has_brief: !!s.brief,
    pictures: s.pictures.length,
    ...(was ? {} : { made: true }),
    ...(added !== undefined ? { added } : {}),
    ...(fromVideo ? { from_video_added: fromVideo.added } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    link: `${ctx.origin}${sheetOf(kind, s.id)}`,
  };
};

export const editorStyleTools: ToolModule = {
  defs: [
    {
      name: "editor_style_save",
      description: "Make or change an Editor editing style (id: change one; from_edit: copy an edit). notes: only words the user typed in this chat. playbook: what you researched about this kind of edit.",
      inputSchema: {
        type: "object",
        properties: {
          id: str,
          name: str,
          notes: str,
          versions: { type: "integer" },
          target_s: { type: "integer" },
          pace: { enum: ["tight", "natural"] },
          punch: { enum: [1, 1.15, 1.3] },
          size: { enum: ["1080x1920", "2160x3840", "footage"] },
          passes: { type: "boolean" },
          from_edit: str,
          playbook: { type: "object", properties: { text: str, sources: { type: "array", items: { type: "object", properties: { title: str, url: str } } } } },
        },
      },
    },
    {
      name: "editor_style_use",
      description: "Set an edit's editing style before it runs: editor_create with start: false, this, then editor_run. style = a style's id or name (none takes it off); leave both out to list the user's styles.",
      inputSchema: { type: "object", properties: { edit: str, style: str } },
    },
    {
      name: "editor_style_propose",
      description: "Read a reference and propose an editing style with the look of its cards: from_video (a Media Library video's version_id; fetch a link in first), pictures (the newest n the user sent here) or from_finished (their finished edits). Only a proposal: the user keeps or dismisses it on its sheet.",
      inputSchema: { type: "object", properties: { from_video: str, pictures: { type: "integer" }, from_finished: { type: "boolean" } } },
    },
    {
      name: "animation_style_save",
      description: "Make or change an Editor animation style, the look of an edit's animated cards (id: change one). brief: only words the user typed in this chat. pictures: how many of the newest pictures they sent in this chat to add. from_video: a Media Library video's version_id whose look the style follows (a reference video): stills spread over it are added as pictures.",
      inputSchema: { type: "object", properties: { id: str, name: str, brief: str, pictures: { type: "integer" }, from_video: str } },
    },
  ],
  handlers: {
    editor_style_save: async (a, ctx) => {
      const body: Args = Object.fromEntries((Object.keys(FIELDS) as (keyof typeof FIELDS)[]).filter((k) => a[k] != null).map((k) => [FIELDS[k], a[k]]));
      if (a.size != null) body.size = sizeOf(a.size);
      const notes = typeof a.notes === "string" ? a.notes.trim() : "";
      // the researched playbook: kept apart from the notes and marked as the AI's by the route. Saved alone, it opens nothing: the edit goes on
      if (a.playbook != null) body.playbook = a.playbook;
      const quiet = a.id != null && Object.keys(body).length === 1 && body.playbook !== undefined && !notes;
      if (a.id == null) {
        if (!body.name) throw new ToolError("Give the new style a name.");
        const { style: made, pasted } = await saved<EditingStyle>(ctx, "/api/editor/styles", "POST", { ...body, ...(notes ? { notes } : {}), ...(a.from_edit != null ? { fromEdit: String(a.from_edit) } : {}) });
        await ctx.open?.(sheetOf("styles", made.id));
        return { ...out(made), made: true, ...(pasted ? { note: FROM_PASTE("The notes were") } : {}), link: `${ctx.origin}${sheetOf("styles", made.id)}` };
      }
      if (a.from_edit != null) throw new ToolError("from_edit makes a new style: leave id out.");
      if (!Object.keys(body).length && !notes) throw new ToolError(`Nothing to change: give ${Object.keys(FIELDS).join(", ")}, size, notes or playbook.`);
      const s = one(await styles(ctx), a.id);
      const { style: now, pasted } = await saved<EditingStyle>(ctx, `/api/editor/styles/${s.id}`, "PUT", { ...body, ...(notes ? { addNotes: notes } : {}) });
      if (!quiet) await ctx.open?.(sheetOf("styles", now.id));
      const note = [notes ? "The words were added under the style's notes. The user rewrites or shortens the notes on the style's sheet." : "", pasted ? FROM_PASTE("They were") : ""].filter(Boolean).join(" ");
      return { ...out(now), ...(note ? { note } : {}), link: `${ctx.origin}${sheetOf("styles", now.id)}` };
    },
    animation_style_save: saveStyle("animation"),
    // a proposal is never a style: its sheet opens and only the person's Keep there makes one (the route refuses a tool)
    editor_style_propose: async (a, ctx) => {
      const body = a.from_video ? { clip: String(a.from_video) } : a.pictures != null ? { chat: Number(a.pictures) } : a.from_finished === true ? { finished: true } : null;
      if (!body) throw new ToolError("Give from_video, pictures or from_finished.");
      const res = await ctx.api("/api/editor/styles/propose", "POST", body);
      if (res.status === 202) return { note: `Stills of the video are still being made (${String(((await res.json()) as { waiting?: string }).waiting ?? "")}): call again with the same from_video later.` };
      const p = (await res.json()) as StyleProposal;
      const at = `/editor?tab=styles&proposal=${p.id}`;
      await ctx.open?.(at);
      return {
        proposal: p.id,
        from: p.fromLabel,
        seen: p.seen,
        would_use: { name: p.style.name, pace: p.style.pace, punch: p.style.punch, versions: p.style.versions, target_s: p.style.targetS, has_cards_look: !!p.animation?.brief },
        note: `Only a proposal: tell the user in a line or two what you saw. They keep it, change it first, or dismiss it on its sheet${ctx.open ? ", which is open" : ""}; you cannot keep it.`,
        link: `${ctx.origin}${at}`,
      };
    },
    editor_style_use: async (a, ctx) => {
      const view = await ctx.json<EditingStylesView>("/api/editor/styles");
      const all = view.styles;
      // the workspace's default is what New edit opens on; the AI names a style only when the user asks for one
      if (a.edit == null && a.style == null) return { styles: all.map(out), ...(view.default ? { default: view.default } : {}), link: sheet(ctx) };
      if (!a.edit) throw new ToolError("Give the edit's id: editor_list lists them.");
      if (a.style == null || !String(a.style).trim()) throw new ToolError("Give style: a style's id or name, or none to take the edit's style off.");
      const off = /^none$/i.test(String(a.style).trim());
      const e = await ctx.json(`/api/editor/${encodeURIComponent(String(a.edit))}`, "PATCH", { style: off ? null : one(all, a.style).id });
      const cut = ((e.drafts as unknown[] | undefined) ?? []).length > 0;
      return {
        ...pick(e, ["id", "name", "versions"]),
        target_s: e.targetS,
        style: (e.style as { name?: string } | undefined)?.name ?? "none",
        ...(cut ? { note: "The drafts are as they were: editor_run from script cuts them again with this." } : {}),
        link: `${ctx.origin}/editor/${String(e.id)}`,
      };
    },
  },
  steps: { editor_style_propose: "Reading the reference", editor_style_save: "Saving the editing style", animation_style_save: "Saving the animation style", editor_style_use: "Setting the edit's style" },
};
