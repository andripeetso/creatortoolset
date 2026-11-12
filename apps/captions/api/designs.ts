import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { DESIGN_LIMITS, formatOf, type Design, type DesignAnswer, type DesignPage, type DesignSummary } from "../contracts/design";
import { FONT_OPTIONS } from "../src/lib/types";
import { aiFor, completeWithFallback } from "./ai-complete";
import { completeVisionWithFallback, type VisionImage } from "./ai-vision";
import type { AuthVars } from "./auth";
import { animationStyles, findAnimation } from "./editor/animation-styles";
import { stylePictures } from "./editor/cards/step";
import { sourcesWorkspace } from "./editor/store";
import { extractClipJpegFrame } from "./lib/clip-frame";
import { cleanPages, coverPage, plainPages, slideWords } from "./lib/design-check";
import { env } from "./lib/env";
import { parseJsonObject } from "./lib/instagram/vision";
import { PICTURE_EXT, parsePictureUpload } from "./lib/workshop/pictures";
import { blobs, libraryDb } from "./library/db";
import { whoFor } from "./library/describe";
import { ownedSession, readDoc } from "./workshop";

/**
 * Designs (contracts/design.ts): pages of layers the person's AI designs and the person changes by hand. One JSON file
 * a design, $DATA_DIR/designs/<owner>/<id>.json, with its pictures beside it in <id>/. The AI's call is the task and
 * the answer's shape; the look is the brief and the pictures of the animation style the person picked, and nothing
 * else: no pack text, no rules drawn from them. Every page's words are the author's (cleanPages leaves out a text
 * layer that says anything else).
 */

const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PICTURE = /^[a-z0-9]{8}\.(jpg|png|webp)$/;
const TYPE: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const LABEL = "Designer";
/** The look's pictures a design call carries, as the cards' make call does: the ones made and liked first. */
const LOOK_PICTURES = 8;

const dirOf = (owner: string) => path.join(env.dataDir, "designs", owner);
const fileOf = (owner: string, id: string) => path.join(dirOf(owner), `${id}.json`);
const picturesOf = (owner: string, id: string) => path.join(dirOf(owner), id);

async function read(owner: string, id: string): Promise<Design | null> {
  if (!USER.test(owner) || !UUID.test(id)) return null;
  try {
    return JSON.parse(await readFile(fileOf(owner, id), "utf8")) as Design;
  } catch {
    return null;
  }
}

async function save(d: Design): Promise<Design> {
  await mkdir(dirOf(d.owner), { recursive: true });
  const file = fileOf(d.owner, d.id);
  // a file of its own for each save: two at once (a save by hand and an AI's) never write into each other
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(d));
  await rename(tmp, file);
  return d;
}

const summaryOf = (d: Design): DesignSummary => ({ id: d.id, name: d.name, kind: d.kind, format: d.format, width: d.width, height: d.height, pages: d.pages.length, ...(d.from ? { from: d.from } : {}), updatedAt: d.updatedAt });

async function addPicture(d: Design, bytes: Buffer, ext: string): Promise<string> {
  const id = `${randomBytes(4).toString("hex")}.${ext}`;
  await mkdir(picturesOf(d.owner, d.id), { recursive: true });
  await writeFile(path.join(picturesOf(d.owner, d.id), id), bytes);
  d.pictures.push(id);
  return id;
}

/** What the design call may not go on without, as the person reads it; `status` is the answer's. */
export class DesignError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502 = 400,
  ) {
    super(message);
  }
}

/** The slides of a Workshop carousel piece the caller may see, as words (picture tokens out), with the piece's title. */
async function slidesOf(user: AuthVars["user"], session: string, doc: string): Promise<{ title: string; slides: string[] }> {
  const meta = await ownedSession(session, user);
  const piece = meta ? await readDoc(meta.id, doc) : null;
  if (!piece) throw new DesignError("Not found", 404);
  if (piece.kind !== "carousel") throw new DesignError("Only a carousel piece has slides to design");
  const slides = piece.blocks.map((b) => slideWords(b.text)).filter(Boolean).slice(0, DESIGN_LIMITS.pages);
  if (!slides.length) throw new DesignError("This carousel has no words yet: write its slides first");
  return { title: piece.title, slides };
}

/* ---- the AI's call ---- */

/** How layers are written: part of the design call, and what an AI that asks for a design's pages is told (GET /:id/pages). */
export const DESIGN_LAYERS = `Every layer has "x", "y", "w", "h" in pixels from the page's top left corner, and may have "rotate" (degrees about its middle) and "opacity" (0 to 1). Layers are drawn in order, a later one over an earlier one. The kinds:
- {"type":"text","text":"…","font":"…","size":64,"color":"#rrggbb","align":"left|center|right","valign":"top|middle|bottom","lineHeight":1.15,"upper":false,"outline":{"color":"#rrggbb","width":8}}: the words wrap inside w; size is the letter height in pixels.
- {"type":"shape","shape":"rect|ellipse","fill":"#rrggbb","radius":0,"stroke":{"color":"#rrggbb","width":4}}
- {"type":"image","picture":"<id>","fit":"cover|contain","radius":0}: only a picture listed under "Pictures".
- {"type":"drawing","svg":"<svg viewBox=\\"0 0 100 100\\">…</svg>"}: an illustration of your own, as SVG shapes only: path, rect, circle, ellipse, line, polyline, polygon and g, and defs with linearGradient, radialGradient, stop, clipPath and mask, with plain attributes. No text, image, link, script, style element or filter.`;
const AUTHORS_WORDS = "The words on each page are the author's. Place every word of a page on that page, as written: you choose where the words go, how big they are and how they are split across text layers, and you never add, drop or change one.";

export const DESIGN_SYSTEM = `You design pictures for a creator: carousel slides, video covers and thumbnails. Your design is data, not a picture: pages of layers that the app draws exactly as you give them, and that the person then moves, resizes and restyles by hand.

${DESIGN_LAYERS}

${AUTHORS_WORDS}

Answer with JSON only, one page for each page asked for, in order:
{"pages":[{"background":"#rrggbb","layers":[…]}]}`;

export interface DesignAsk {
  kind: Design["kind"];
  w: number;
  h: number;
  /** each page's own words */
  pages: readonly string[];
  /** the picked style's brief, and how many of its pictures go with the call (the made and liked ones first) */
  look?: { name: string; brief: string; made: number; inspirations: number };
  notes?: string;
  pictures: readonly { id: string; what: string }[];
}

export function designPrompt(a: DesignAsk): { system: string; user: string } {
  const what = a.kind === "carousel" ? `A carousel of ${a.pages.length} ${a.pages.length === 1 ? "slide" : "slides"}` : a.kind === "cover" ? "A video's cover" : "A video's thumbnail";
  const look = a.look
    ? [
        `The look: ${JSON.stringify(a.look.name)}${a.look.brief.trim() ? `, in the author's own words:\n${a.look.brief.trim()}` : ""}`,
        a.look.made + a.look.inspirations
          ? `The pictures with this message show that look: ${[a.look.made && `the first ${a.look.made} ${a.look.made === 1 ? "is one" : "are ones"} the author made and liked`, a.look.inspirations && `${a.look.made ? "the rest are" : "they are"} inspirations`].filter(Boolean).join(", ")}.`
          : "",
      ].filter(Boolean).join("\n")
    : "The look: none picked.";
  return {
    system: DESIGN_SYSTEM,
    user: [
      `${what}. Each page is ${a.w} × ${a.h} pixels.`,
      `Fonts: ${FONT_OPTIONS.map((f) => JSON.stringify(f.family)).join(", ")}`,
      look,
      ...(a.notes?.trim() ? [`Notes from the author:\n${a.notes.trim()}`] : []),
      `Pictures:\n${a.pictures.length ? a.pictures.map((p) => `${p.id} = ${p.what}`).join("\n") : "(none)"}`,
      `Pages:\n${a.pages.map((p, k) => `--- page ${k + 1} ---\n${p}`).join("\n")}`,
    ].join("\n\n"),
  };
}

/** The answer's pages, as given: a list is all that is asked of its shape here; cleanPages checks what is in it. */
export function parseDesign(text: string): unknown[] {
  const o = parseJsonObject(text);
  if (!Array.isArray(o.pages) || !o.pages.length) throw new Error("The AI's answer has no pages");
  return o.pages;
}

/** One answer from the person's AI and nothing but an answer, as the cards' calls are made (api/editor/cards/step.ts): with pictures when the look has them, in words alone when it has none. */
async function ask<T>(actor: string, prompt: { system: string; user: string }, images: VisionImage[], parse: (text: string) => T): Promise<T> {
  const who = whoFor(actor);
  if (images.length) return (await completeVisionWithFallback(prompt.system, prompt.user, images, undefined, parse, who, { label: LABEL, job: "editor" })).value;
  const route = aiFor(who, "editor", LABEL);
  if (route.off) throw new DesignError(route.off);
  return completeWithFallback(prompt.system, prompt.user, undefined, parse, { ...route, retries: 0 });
}

/** The person's AI designs the pages: the words stay the author's, the look is the picked style's brief and pictures. */
export async function designPages(user: AuthVars["user"], d: Design, body: { look?: unknown; notes?: unknown }): Promise<DesignAnswer> {
  // every page of the design, with the words it may place: a piece's slides as they are now, else what the page
  // says (or the design's name). A page the person added beyond the slides is one of them, and stays
  const mine = await pagesForAi(user, d);
  const words = mine.words ?? mine.pages.map((p) => saidOn(p) || d.name);
  const lookId = typeof body.look === "string" ? body.look : body.look === null ? "" : (d.look ?? "");
  const style = lookId ? findAnimation(d.owner, lookId) : null;
  if (lookId && !style) throw new DesignError("That style is gone: pick another", 404);
  const shown = style ? await stylePictures(d.owner, style, LOOK_PICTURES) : { images: [], made: 0, inspirations: 0 };
  const prompt = designPrompt({
    kind: d.kind,
    w: d.width,
    h: d.height,
    pages: words,
    ...(style ? { look: { name: style.name, brief: style.brief, made: shown.made, inspirations: shown.inspirations } } : {}),
    notes: typeof body.notes === "string" ? body.notes.slice(0, DESIGN_LIMITS.notes) : "",
    pictures: d.pictures.map((id) => ({ id, what: "version" in (d.from ?? {}) && id === d.pictures[0] ? "the video's own frame" : "a picture the author added" })),
  });
  let raw: unknown[];
  try {
    raw = await ask(d.owner, prompt, shown.images, parseDesign);
  } catch (e) {
    if (e instanceof DesignError) throw e;
    throw new DesignError(e instanceof Error ? e.message : String(e), 502);
  }
  // a page the answer has beyond the pages asked for is not looked at
  const made = cleanPages(raw.slice(0, words.length), { w: d.width, h: d.height, pictures: d.pictures, words });
  // a page for each page of words: one the answer left out, or left empty, stays as it was
  const pages: DesignPage[] = mine.pages.map((was, k) => {
    const now = made.pages[k];
    if (now?.layers.length) return { ...now, id: was.id, ...(was.name ? { name: was.name } : {}) };
    made.notes.push(`Page ${k + 1}: nothing in the answer could be drawn, so it is as it was`);
    return was;
  });
  if (!made.pages.some((p) => p.layers.length)) throw new DesignError(`The AI's design had nothing that could be drawn${made.notes.length ? ` (${made.notes.slice(0, 2).join("; ")})` : ""}`, 502);
  // onto the design as it is now: the AI can take a minute, and a design deleted meanwhile stays deleted
  const still = await read(d.owner, d.id);
  if (!still) throw new DesignError("Not found", 404);
  const design = await save({ ...still, pages, ...(style ? { look: style.id } : { look: undefined }), updatedAt: Date.now() });
  return { design, notes: made.notes };
}

/* ---- an AI that writes the layers itself (the assistant, a connected AI) ---- */

const saidOn = (p: DesignPage): string => p.layers.flatMap((l) => (l.type === "text" ? [l.text] : [])).join("\n");

/**
 * The pages as an AI works on them. A carousel piece's design: its pages, a plain page for each slide written since
 * (so that slide can be designed too), and each page's words as the slide has them now: those are held, as in the
 * design call. A cover or a thumbnail: its pages, and no words held, since what it says is asked for in the chat.
 */
async function pagesForAi(user: AuthVars["user"], d: Design): Promise<{ pages: DesignPage[]; words: string[] | null }> {
  if (!("session" in (d.from ?? {}))) return { pages: d.pages, words: null };
  const { slides } = await slidesOf(user, (d.from as { session: string }).session, (d.from as { doc: string }).doc);
  const taken = new Set(d.pages.map((p) => p.id));
  const more = plainPages(slides, d.width, d.height)
    .slice(d.pages.length)
    .map((p, k) => ({ ...p, id: taken.has(p.id) ? `p${Date.now().toString(36)}${k}` : p.id }));
  const pages = [...d.pages, ...more].slice(0, DESIGN_LIMITS.pages);
  return { pages, words: pages.map((p, k) => slides[k] ?? saidOn(p)) };
}

/** What an AI is given to design from: the size, the fonts, the pictures, the person's looks in their own words, each page with its words, and how layers are written. */
async function forAi(user: AuthVars["user"], d: Design) {
  const { pages, words } = await pagesForAi(user, d);
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    width: d.width,
    height: d.height,
    fonts: FONT_OPTIONS.map((f) => f.family),
    pictures: d.pictures.map((id) => ({ id, what: "version" in (d.from ?? {}) && id === d.pictures[0] ? "the video's own frame" : "a picture the author added" })),
    // a look is its pictures first, and those are not sent here: its name and brief are what words can carry
    looks: animationStyles(d.owner)
      .filter((s) => s.brief.trim())
      .slice(0, 12)
      .map((s) => ({ name: s.name, brief: s.brief.trim().slice(0, 600) })),
    pages: pages.map((p, k) => ({ page: k + 1, ...(words ? { words: words[k] } : {}), background: p.background, layers: p.layers })),
    how: `${DESIGN_LAYERS}\n\n${words ? `${AUTHORS_WORDS} Each page's own are its "words"; to change them, change the piece's slide first.` : "Write only words the user asked for or agreed to. A page numbered one past the last is added."}\n\nTo change pages, give them as [{"page":1,"background":"#rrggbb","layers":[…]}]: each page given is replaced whole, the others stay.`,
  };
}

/** An AI's pages onto the design: each page named is replaced whole, checked as the design call's answer is. */
async function writeForAi(user: AuthVars["user"], d: Design, given: unknown): Promise<DesignAnswer> {
  if (!Array.isArray(given) || !given.length) throw new DesignError('Give the pages to replace: [{"page":1,"background":"#rrggbb","layers":[…]}]');
  const { pages, words } = await pagesForAi(user, d);
  const next = [...pages];
  const notes: string[] = [];
  let drawn = 0;
  for (const raw of given.slice(0, DESIGN_LIMITS.pages) as Array<Record<string, unknown> | null>) {
    const n = Number.isInteger(raw?.page) ? (raw!.page as number) : 0;
    // a page one past the last is a new page, where the pages are not a piece's slides and there is room
    const was = next[n - 1] ?? (!words && n === next.length + 1 && n <= DESIGN_LIMITS.pages ? { id: `p${Date.now().toString(36)}${n}`, background: "#ffffff", layers: [] } : undefined);
    if (!was) {
      notes.push(`There is no page ${String(raw?.page)}: this design has ${next.length}`);
      continue;
    }
    const made = cleanPages([raw], { w: d.width, h: d.height, pictures: d.pictures, ...(words ? { words: [words[n - 1] ?? ""] } : {}) });
    notes.push(...made.notes.map((note) => note.replace(/^Page 1:/, `Page ${n}:`)));
    const page = made.pages[0];
    if (!page?.layers.length) {
      notes.push(`Page ${n}: nothing given could be drawn, so it is as it was`);
      continue;
    }
    // the page keeps its id and name, and its colour when none is given
    next[n - 1] = { ...page, id: was.id, ...(was.name ? { name: was.name } : {}), background: typeof raw?.background === "string" ? page.background : was.background };
    drawn++;
  }
  if (!drawn) throw new DesignError(`Nothing given could be drawn${notes.length ? ` (${notes.slice(0, 3).join("; ")})` : ""}`);
  return { design: await save({ ...d, pages: next, updatedAt: Date.now() }), notes };
}

/* ---- routes ---- */

export const designsApp = new Hono<{ Variables: AuthVars }>();
type C = Context<{ Variables: AuthVars }>;

designsApp.use("*", async (c, next) => (c.get("user").role === "visitor" || !USER.test(c.get("user").username) ? c.json({ error: "Sign in with an account to make designs" }, 403) : next()));

const answer = async (c: C, run: () => Promise<object>) => {
  try {
    return c.json(await run());
  } catch (e) {
    if (e instanceof DesignError) return c.json({ error: e.message }, e.status);
    throw e;
  }
};
const body = async (c: C) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
const mine = async (c: C): Promise<Design> => {
  const d = await read(c.get("user").username, c.req.param("id") ?? "");
  if (!d) throw new DesignError("Not found", 404);
  return d;
};

designsApp.get("/", (c) =>
  answer(c, async () => {
    const owner = c.get("user").username;
    const names = await readdir(dirOf(owner)).catch(() => [] as string[]);
    const all = (await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => read(owner, n.slice(0, -5))))).filter((d): d is Design => !!d);
    const { session, doc } = c.req.query();
    return all
      .filter((d) => !session || !doc || ("session" in (d.from ?? {}) && (d.from as { session: string; doc: string }).session === session && (d.from as { doc: string }).doc === doc))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summaryOf);
  }),
);

designsApp.post("/", (c) =>
  answer(c, async () => {
    const user = c.get("user");
    const b = await body(c);
    const format = formatOf(b.format);
    if (!format) throw new DesignError("Pick one of the picture sizes");
    const now = Date.now();
    const d: Design = { id: randomUUID(), owner: user.username, name: "Untitled design", kind: format.kind, format: format.id, width: format.w, height: format.h, pages: [], pictures: [], createdAt: now, updatedAt: now };
    const named = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, DESIGN_LIMITS.name) : "";
    if (typeof b.session === "string" && typeof b.doc === "string") {
      if (format.kind !== "carousel") throw new DesignError("A carousel's slides take a carousel size");
      const { title, slides } = await slidesOf(user, b.session, b.doc);
      d.name = named || title.slice(0, DESIGN_LIMITS.name) || d.name;
      d.from = { session: b.session, doc: b.doc };
      d.pages = plainPages(slides, d.width, d.height);
    } else if (typeof b.version === "string" && typeof b.t === "number" && Number.isFinite(b.t) && b.t >= 0) {
      if (format.kind === "carousel") throw new DesignError("A video's frame takes the cover or the thumbnail size");
      // the frame is copied in: the design keeps what it shows, whatever happens to the video
      if (!sourcesWorkspace(user.username, [b.version])) throw new DesignError("Not found", 404);
      const row = libraryDb().prepare("SELECT v.source_key, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(b.version) as { source_key: string; title: string } | undefined;
      if (!row) throw new DesignError("Not found", 404);
      let frame: Buffer;
      try {
        frame = await extractClipJpegFrame({ src: await blobs.localCopy(row.source_key), cacheDir: path.join(dirOf(user.username), ".frames"), atMs: Math.round(b.t * 1000) });
      } catch (e) {
        throw new DesignError(`That moment of the video could not be read (${e instanceof Error ? e.message : String(e)})`, 502);
      }
      const title = typeof b.title === "string" ? b.title : "";
      d.name = named || (title.trim() || row.title).slice(0, DESIGN_LIMITS.name);
      d.from = { version: b.version, t: b.t };
      d.pages = [coverPage(await addPicture(d, frame, "jpg"), title, d.width, d.height)];
    } else if (b.blank === true) {
      // a design of its own: empty pages to draw on
      const count = Number.isInteger(b.pages) ? Math.min(DESIGN_LIMITS.pages, Math.max(1, b.pages as number)) : 1;
      d.name = named || d.name;
      d.pages = Array.from({ length: count }, (_, k) => ({ id: `p${k + 1}`, background: "#ffffff", layers: [] }));
    } else throw new DesignError("Say what the design is of: a carousel piece (session and doc), a video's moment (version and t), or blank: true");
    return save(d);
  }),
);

designsApp.get("/:id", (c) => answer(c, () => mine(c)));

designsApp.put("/:id", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    const b = await body(c);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, DESIGN_LIMITS.name) : d.name;
    // the person's own changes: checked for what a page can hold, never for whose words they are
    const pages = Array.isArray(b.pages) ? cleanPages(b.pages, { w: d.width, h: d.height, pictures: d.pictures }).pages : d.pages;
    if (!pages.length) throw new DesignError("A design keeps at least one page");
    return save({ ...d, name, pages, updatedAt: Date.now() });
  }),
);

designsApp.delete("/:id", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    await rm(fileOf(d.owner, d.id), { force: true });
    await rm(picturesOf(d.owner, d.id), { recursive: true, force: true });
    return { ok: true };
  }),
);

designsApp.post("/:id/design", (c) => answer(c, async () => designPages(c.get("user"), await mine(c), await body(c))));

// an AI that designs the pages itself: what it reads, and what it writes
designsApp.get("/:id/pages", (c) => answer(c, async () => forAi(c.get("user"), await mine(c))));
designsApp.post("/:id/pages", (c) => answer(c, async () => writeForAi(c.get("user"), await mine(c), (await body(c)).pages)));

designsApp.post("/:id/pictures", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    if (d.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: take one out first`);
    let sent: ReturnType<typeof parsePictureUpload>;
    try {
      sent = parsePictureUpload(await body(c));
    } catch (e) {
      throw new DesignError(e instanceof Error ? e.message : String(e));
    }
    const id = await addPicture(d, sent.bytes, PICTURE_EXT[sent.type]);
    await save({ ...d, updatedAt: Date.now() });
    return { id };
  }),
);

designsApp.get("/:id/pictures/:pid", async (c) => {
  const d = await read(c.get("user").username, c.req.param("id"));
  const pid = c.req.param("pid");
  if (!d || !PICTURE.test(pid) || !d.pictures.includes(pid)) return c.json({ error: "Not found" }, 404);
  const bytes = await readFile(path.join(picturesOf(d.owner, d.id), pid)).catch(() => null);
  if (!bytes) return c.json({ error: "Not found" }, 404);
  return c.body(new Uint8Array(bytes), 200, { "Content-Type": TYPE[pid.split(".")[1]!]!, "Cache-Control": "private, max-age=31536000, immutable" });
});
