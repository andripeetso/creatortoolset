import { DESIGN_FORMATS, type Design, type DesignAnswer, type DesignSummary } from "../../contracts/design";
import { type Args, str, ToolError, type ToolContext, type ToolModule } from "./types";

// The designer's tools: start (or find) a design, read its pages, write layers onto them. The AI that calls them
// designs the pages itself. What it writes goes through POST /api/designs/:id/pages, which checks it as the designer's
// own AI call is checked (api/designs.ts): every value brought inside what a page holds, and on a carousel piece's
// design the words kept the slide's own. The person sees the pages change in the open designer and takes it back
// with ⌘Z.

type ForAi = Args & { id: string; name: string; pages: Args[] };
type Look = { pictures: Array<{ page: number; jpeg: string; spills: string[] }>; why?: string };

/**
 * The pages as they are drawn, for the answer of a read or a write: each as a picture the AI is shown (`_images`,
 * api/mcp.ts), and the words that do not fit their box. Where no picture can be made, the answer says so.
 */
async function seen(ctx: ToolContext, at: string, pages: number[]): Promise<Args> {
  const look = await ctx.json<Look>(`${at}/look?pages=${pages.join(",")}`).catch((): Look => ({ pictures: [], why: "No pictures of the pages could be made" }));
  const spills = look.pictures.flatMap((p) => p.spills.map((s) => `Page ${p.page}: ${s}`));
  return {
    ...(spills.length ? { does_not_fit: spills } : {}),
    ...(look.pictures.length ? { _images: look.pictures.map((p) => ({ text: `Page ${p.page} as it is drawn:`, jpeg: p.jpeg })) } : { no_pictures: look.why ?? "No pictures of the pages could be made" }),
  };
}

const enc = (v: unknown) => encodeURIComponent(String(v));
const about = (origin: string, d: { id: string; name: string; width: number; height: number }, pages: number) => ({ id: d.id, name: d.name, link: `${origin}/design/${d.id}`, size: `${d.width} × ${d.height}`, pages });

export const designTools: ToolModule = {
  defs: [
    {
      name: "design_make",
      description:
        "Start a design the user edits by hand in the designer: a Workshop carousel piece's slides as pages (session, and doc: the piece's id; a piece that has a design gets that one back), or a cover or thumbnail from a library video's frame (version: the video's version id, t in seconds, title), or blank pages (format, name, pages). design_layers designs it.",
      inputSchema: { type: "object", properties: { session: str, doc: str, version: str, t: { type: "number" }, title: str, format: { type: "string", enum: DESIGN_FORMATS.map((f) => f.id) }, name: str, pages: { type: "integer" } } },
    },
    {
      name: "design_layers",
      description: "A design's pages (id: as in its /design/<id> address). With only the id: each page's words and layers, and how layers are written. With pages ([{page, background, layers}]) those pages are replaced, and the answer says what was left out and why.",
      inputSchema: { type: "object", properties: { id: str, pages: { type: "array", items: { type: "object" } } }, required: ["id"] },
    },
  ],
  handlers: {
    design_make: async (a, ctx) => {
      const piece = !!a.session && !!a.doc;
      if (!piece && !a.version && !a.format) throw new ToolError("Say what to design: a carousel piece (session and doc), a library video's frame (version, and t in seconds), or blank pages (format, and a name).");
      if (piece) {
        // the piece's own design, with whatever the person has done on it by hand: never a second one
        const had = (await ctx.json<DesignSummary[]>(`/api/designs?session=${enc(a.session)}&doc=${enc(a.doc)}`))[0];
        if (had) return { ...about(ctx.origin, had, had.pages), existed: true };
      }
      const d = await ctx.json<Design>(
        "/api/designs",
        "POST",
        piece ? { format: a.format ?? "portrait", session: a.session, doc: a.doc } : a.version ? { format: a.format ?? "cover", version: a.version, t: Number(a.t) || 0, title: a.title } : { format: a.format, blank: true, name: a.name, pages: a.pages },
      );
      return about(ctx.origin, d, d.pages.length);
    },
    design_layers: async (a, ctx) => {
      if (!a.id) throw new ToolError("Give the design's id: design_make starts one, or finds a piece's.");
      const at = `/api/designs/${enc(a.id)}`;
      if (a.pages === undefined) {
        const read = await ctx.json<ForAi>(`${at}/pages`);
        return { ...read, ...(await seen(ctx, at, read.pages.map((_, k) => k + 1))) };
      }
      const { design, notes } = await ctx.json<DesignAnswer>(`${at}/pages`, "POST", { pages: a.pages });
      const wrote = (Array.isArray(a.pages) ? a.pages : []).map((p) => Number((p as Args | null)?.page)).filter((n) => Number.isInteger(n) && n >= 1);
      return { ...about(ctx.origin, design, design.pages.length), ...(notes.length ? { left_out: notes } : {}), ...(await seen(ctx, at, wrote)) };
    },
  },
  steps: { design_make: "Starting the design", design_layers: "Working on the design" },
  // the design as a card under the reply: it opens in the designer
  work: (_name, _a, r) => (r.id && r.link ? { card: { id: `design:${String(r.id)}`, kind: "link", title: String(r.name ?? "Design"), href: `/design/${String(r.id)}`, status: "done", detail: `Design: ${String(r.pages)} ${r.pages === 1 ? "page" : "pages"}, ${String(r.size)}` } } : null),
};
