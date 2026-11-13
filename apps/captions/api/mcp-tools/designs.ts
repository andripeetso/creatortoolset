import { DESIGN_FORMATS, type Design, type DesignAnswer, type DesignListed } from "../../contracts/design";
import { type Args, pick, str, ToolError, type ToolContext, type ToolModule, when } from "./types";

// The Designer's tools, for the AI that designs: find a design, read it, start one, change it. The AI designs the
// frames itself. design_get is the only one a description has to explain in full: its answer carries how a design
// is written and changed (api/designs.ts HOW), each frame as a picture, and a look's pictures when one is asked
// for, so nothing about the format rides on a turn that designs nothing. What the AI writes goes through
// POST /api/designs/:id/pages, checked like everything else that is saved (api/lib/design-check.ts), with a
// carousel slide's words held. The person sees the frames change in the open designer and takes it back with ⌘Z.

type Frame = Args & { id: string; n: number };
type ForAi = Args & { id: string; name: string; frames: Frame[]; look?: { name: string; pictures: Array<{ what: string; jpeg: string }> } | string };
type Look = { pictures: Array<{ page: number; jpeg: string; spills: string[] }>; why?: string };
type Image = { text: string; jpeg: string };

const enc = (v: unknown) => encodeURIComponent(String(v));
const about = (origin: string, d: { id: string; name: string }, frames: number) => ({ id: d.id, name: d.name, link: `${origin}/design/${d.id}`, frames });

/** The frames as they are drawn: each as a picture the AI is shown (six at a time), and the words that do not fit their box. Where no picture can be made, the answer says why. */
async function seen(ctx: ToolContext, at: string, frames: readonly Frame[], only?: readonly string[]): Promise<{ said: Args; images: Image[] }> {
  const ask = only?.length ? frames.filter((f) => only.includes(f.id)) : frames;
  const look = await ctx.json<Look>(`${at}/look?frames=${ask.map((f) => enc(f.id)).join(",")}`).catch((): Look => ({ pictures: [], why: "No pictures of the frames could be made" }));
  const named = (n: number) => {
    const f = frames.find((x) => x.n === n);
    return `Frame ${n}${f ? ` (id ${f.id})` : ""}`;
  };
  const spills = look.pictures.flatMap((p) => p.spills.map((s) => `${named(p.page)}: ${s}`));
  // the frames beyond the six: named, with how to see them
  const missed = look.pictures.length ? ask.filter((f) => !look.pictures.some((p) => p.page === f.n)).map((f) => f.id) : [];
  return {
    said: {
      ...(spills.length ? { does_not_fit: spills } : {}),
      ...(look.pictures.length ? {} : { no_pictures: look.why ?? "No pictures of the frames could be made" }),
      ...(missed.length ? { not_pictured: `Six frames are pictured at a time. To see the others, call design_get with this id and frames: ${JSON.stringify(missed)}` } : {}),
    },
    images: look.pictures.map((p) => ({ text: `${named(p.page)} as it is drawn:`, jpeg: p.jpeg })),
  };
}

export const designTools: ToolModule = {
  defs: [
    {
      name: "design_get",
      description:
        "The Designer: the user's designs, each a canvas of frames (carousel slides, covers, thumbnails) made of layers they edit by hand. With no id it lists them. With an id (as in /design/<id>) it gives every frame with its layers and a picture of it, and how to design and change them; look: a look's name adds that look's pictures; frames: the ids to picture.",
      inputSchema: { type: "object", properties: { id: str, look: str, frames: { type: "array", items: str } } },
    },
    {
      name: "design_make",
      description: "Start a design: blank frames (format, name, pages), a Workshop carousel piece's slides as frames (session, and doc: the piece's id; a piece that has a design gets that one back), or a cover or thumbnail from a library video's frame (version: its version id, t in seconds, title). A frame for a design that exists: design_update.",
      inputSchema: { type: "object", properties: { format: { type: "string", enum: DESIGN_FORMATS.map((f) => f.id) }, name: str, pages: { type: "integer" }, session: str, doc: str, version: str, t: { type: "number" }, title: str } },
    },
    {
      name: "design_update",
      description: "Change a design, as design_get says: frames replaces whole frames or adds new ones of any size, changes sets, adds, removes or reorders single layers, picture copies a library video's moment in. The answer shows the changed frames as pictures and says what was left out or does not fit.",
      inputSchema: { type: "object", properties: { id: str, frames: { type: "array", items: { type: "object" } }, changes: { type: "array", items: { type: "object" } }, picture: { type: "object" } }, required: ["id"] },
    },
  ],
  handlers: {
    design_get: async (a, ctx) => {
      if (!a.id) {
        const all = await ctx.json<DesignListed[]>("/api/designs");
        // what each was made from, by its title when that piece or video is still there, and the brand project it is in
        const from = (d: DesignListed) => (!d.from ? "" : `${"session" in d.from ? "a Workshop carousel" : "a video"}${d.madeFrom ? `: ${d.madeFrom}` : ""}`);
        return { designs: all.map((d) => ({ ...about(ctx.origin, d, d.pages), ...pick({ from: from(d), project: d.projectName ?? "", changed: when(d.updatedAt) }, ["from", "project", "changed"]) })) };
      }
      const at = `/api/designs/${enc(a.id)}`;
      const read = await ctx.json<ForAi>(`${at}/pages${a.look ? `?look=${enc(a.look)}` : ""}`);
      const look = typeof read.look === "object" ? read.look : null;
      const asked = Array.isArray(a.frames) ? a.frames.map(String) : [];
      const drawn = await seen(ctx, at, read.frames, asked);
      // asked for some frames: those alone, as they are and as they are drawn (the rest was read before)
      if (asked.length) return { id: read.id, name: read.name, frames: read.frames.filter((f) => asked.includes(f.id)), ...drawn.said, _images: drawn.images };
      return {
        ...read,
        link: `${ctx.origin}/design/${read.id}`,
        // the look's pictures go as pictures, after the answer
        ...(look ? { look: { name: look.name, pictures: look.pictures.length } } : {}),
        ...drawn.said,
        _images: [...(look?.pictures ?? []).map((p, n) => ({ text: `The look "${look!.name}", picture ${n + 1}: ${p.what}.`, jpeg: p.jpeg })), ...drawn.images],
      };
    },
    design_make: async (a, ctx) => {
      const piece = !!a.session && !!a.doc;
      if (!piece && !a.version && !a.format) throw new ToolError("Say what to design: blank frames (format, and a name), a carousel piece (session and doc), or a library video's frame (version, and t in seconds).");
      if (piece) {
        // the piece's own design, with whatever the person has done on it by hand: never a second one
        const had = (await ctx.json<DesignListed[]>(`/api/designs?session=${enc(a.session)}&doc=${enc(a.doc)}`))[0];
        if (had) return { ...about(ctx.origin, had, had.pages), existed: true };
      }
      const d = await ctx.json<Design>(
        "/api/designs",
        "POST",
        piece ? { format: a.format ?? "portrait", session: a.session, doc: a.doc } : a.version ? { format: a.format ?? "cover", version: a.version, t: Number(a.t) || 0, title: a.title } : { format: a.format, blank: true, name: a.name, pages: a.pages },
      );
      return about(ctx.origin, d, d.pages.length);
    },
    design_update: async (a, ctx) => {
      if (!a.id) throw new ToolError("Give the design's id: design_get lists the designs.");
      const at = `/api/designs/${enc(a.id)}`;
      // a picture first: it is in the design before the frames that may show it are checked
      const picture = a.picture ? (await ctx.json<{ id: string }>(`${at}/pictures`, "POST", a.picture)).id : "";
      const added = picture ? { picture_added: picture } : {};
      if (picture && !a.frames && !a.changes) return { id: a.id, ...added };
      // a change that asks for a cut-out: the picture is cut first (a new picture of the design), and the change becomes
      // a plain one that shows it and remembers the picture it was cut from
      const changes = Array.isArray(a.changes) ? (a.changes as Args[]) : undefined;
      const cuts = (changes ?? []).filter((c) => c && c.cutout === true);
      if (cuts.length) {
        const now = await ctx.json<Design>(at);
        for (const c of cuts) {
          const layer = now.pages.find((p) => p.id === c.frame)?.layers.find((l) => l.id === c.layer);
          if (layer?.type !== "image") throw new ToolError(`A cut-out is of a picture layer: ${String(c.frame)} has no picture layer ${String(c.layer)}.`);
          // refused (no Mac of theirs on, a picture with no subject): its reason, and what that means for the person
          const cut = (
            await ctx.json<{ id: string }>(`${at}/pictures/${enc(layer.picture)}/cutout`, "POST", {}).catch((e: unknown) => {
              throw new ToolError(`${e instanceof Error ? e.message : String(e)}. A picture's background is cut out by the Creator Toolset app on the user's own Mac, so that Mac has to be on with the app open. Nothing was changed.`);
            })
          ).id;
          c.set = { ...(c.set as Args | undefined), picture: cut, uncut: layer.uncut ?? layer.picture };
          delete c.cutout;
        }
      }
      const { design, notes, touched, wrote } = await ctx.json<DesignAnswer & { touched: string[]; wrote: { frame: string; isNew: boolean; layers: string[] }[] }>(`${at}/pages`, "POST", { frames: a.frames, changes: changes ?? a.changes });
      const frames = design.pages.map((p, k) => ({ id: p.id, n: k + 1 }));
      const drawn = await seen(ctx, at, frames, touched);
      // each frame written, with the layers this call wrote in it (a frame given whole: all of them)
      const changed = wrote.map((w) => ({ frame: w.frame, n: frames.find((f) => f.id === w.frame)?.n, ...(w.isNew ? { new: true } : {}), layers: w.layers }));
      return { ...about(ctx.origin, design, design.pages.length), ...added, changed, ...(notes.length ? { left_out: notes } : {}), ...drawn.said, ...(drawn.images.length ? { _images: drawn.images } : {}) };
    },
  },
  steps: { design_get: "Looking at the design", design_make: "Starting the design", design_update: "Designing" },
  // the design as a card under the reply: it opens in the designer
  work: (name, _a, r) =>
    name !== "design_get" && r.id && r.link ? { card: { id: `design:${String(r.id)}`, kind: "link", title: String(r.name ?? "Design"), href: `/design/${String(r.id)}`, status: "done", detail: `Design: ${String(r.frames)} ${r.frames === 1 ? "frame" : "frames"}` } } : null,
};
