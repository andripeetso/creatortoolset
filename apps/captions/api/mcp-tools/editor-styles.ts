import type { EditingStyle, EditingStylesView } from "../../contracts/editor-styles";
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

/** editor_style_use is listed only for an account that has a style (api/mcp.ts, tools/list). */
export const hasStyle = (username: string): boolean => stylesView(username).styles.length > 0;

/** What the tool calls a field → the route's name for it. The notes are sent apart. */
const FIELDS = { name: "name", versions: "versions", target_s: "targetS", pace: "pace", punch: "punch" } as const;

const styles = async (ctx: ToolContext) => (await ctx.json<EditingStylesView>("/api/editor/styles")).styles;
const out = (s: EditingStyle) => ({ id: s.id, name: s.name, versions: s.versions, target_s: s.targetS, pace: s.pace, punch: s.punch, has_notes: !!s.notes });
const sheet = (ctx: ToolContext) => `${ctx.origin}/editor?tab=styles`;

/** One of the person's styles by its id, or by its name in any case. */
function one(all: EditingStyle[], key: unknown): EditingStyle {
  const k = String(key ?? "").trim().toLowerCase();
  const hits = all.filter((s) => s.id === k);
  const found = hits.length ? hits : all.filter((s) => s.name.toLowerCase() === k);
  if (found.length === 1) return found[0]!;
  if (!all.length) throw new ToolError("The user has no editing style yet: editor_style_save makes one.");
  throw new ToolError(`${found.length ? "Several styles have that name: give the id" : "No style has that id or name"}. The user's styles: ${all.map((s) => `${s.name} (${s.id})`).join(", ")}.`);
}

export const editorStyleTools: ToolModule = {
  defs: [
    {
      name: "editor_style_save",
      description:
        "Make or change one of the user's AI Editor editing styles: id changes one, from_edit copies an edit's choices, punch is 1 (none), 1.15 (light) or 1.3 (strong). notes = how it is cut, only in words the user typed in this chat; a change adds them.",
      inputSchema: {
        type: "object",
        properties: { id: str, name: str, notes: str, versions: { type: "integer" }, target_s: { type: "integer" }, pace: { type: "string", enum: ["tight", "natural"] }, punch: { type: "number" }, from_edit: str },
      },
    },
    {
      name: "editor_style_use",
      description: "Set an edit's editing style before it runs: editor_create with start: false, this, then editor_run. style = a style's id or name (none takes it off); leave both out to list the user's styles.",
      inputSchema: { type: "object", properties: { edit: str, style: str } },
    },
  ],
  handlers: {
    editor_style_save: async (a, ctx) => {
      const body: Args = Object.fromEntries((Object.keys(FIELDS) as (keyof typeof FIELDS)[]).filter((k) => a[k] != null).map((k) => [FIELDS[k], a[k]]));
      const notes = typeof a.notes === "string" ? a.notes.trim() : "";
      if (a.id == null) {
        if (!body.name) throw new ToolError("Give the new style a name.");
        const made = await ctx.json<EditingStyle>("/api/editor/styles", "POST", { ...body, ...(notes ? { notes } : {}), ...(a.from_edit != null ? { fromEdit: String(a.from_edit) } : {}) });
        return { ...out(made), made: true, link: sheet(ctx) };
      }
      if (a.from_edit != null) throw new ToolError("from_edit makes a new style: leave id out.");
      if (!Object.keys(body).length && !notes) throw new ToolError(`Nothing to change: give ${Object.keys(FIELDS).join(", ")} or notes.`);
      const s = one(await styles(ctx), a.id);
      const saved = await ctx.json<EditingStyle>(`/api/editor/styles/${s.id}`, "PUT", { ...body, ...(notes ? { addNotes: notes } : {}) });
      return { ...out(saved), ...(notes ? { note: "The words were added under the style's notes. The user rewrites or shortens the notes on the style's sheet." } : {}), link: sheet(ctx) };
    },
    editor_style_use: async (a, ctx) => {
      const all = await styles(ctx);
      if (a.edit == null && a.style == null) return { styles: all.map(out), link: sheet(ctx) };
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
  steps: { editor_style_save: "Saving the editing style", editor_style_use: "Setting the edit's style" },
};
