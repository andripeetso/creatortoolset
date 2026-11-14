import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { DESIGN_ADJUST, DESIGN_BLENDS, DESIGN_FORMATS, DESIGN_LIMITS, DESIGN_SHAPES, formatOf, type Design, type DesignAnswer, type DesignListed, type DesignPage, type DesignSummary } from "../contracts/design";
import { DESIGN_FONTS } from "../src/lib/design/fonts";
import type { AuthVars } from "./auth";
import { animationStyles } from "./editor/animation-styles";
import { stylePictures } from "./editor/cards/step";
import { sourcesWorkspace } from "./editor/store";
import { extractClipJpegFrame } from "./lib/clip-frame";
import { cutOut } from "./lib/cutouts";
import { cleanPages, coverPage, plainPages, slideWords, withFrames } from "./lib/design-check";
import { pagePictures } from "./lib/design-picture";
import { env } from "./lib/env";
import { pluginLooks } from "./lib/plugin";
import { PICTURE_EXT, parsePictureUpload } from "./lib/workshop/pictures";
import { blobs, libraryDb } from "./library/db";
import { ffmpeg } from "./library/media/run";
import { ownedProjects, resolveProjectId } from "./lib/workshop/workspace";
import { ownedSession, readDoc } from "./workshop";

/**
 * Designs (contracts/design.ts): a canvas of frames, each a picture made of layers, that the person's AI designs and
 * the person changes by hand. One JSON file a design, $DATA_DIR/designs/<owner>/<id>.json, with its pictures beside
 * it in <id>/. The app itself asks no AI anything here: the person's AI designs through the assistant's tools
 * (api/mcp-tools/designs.ts), which read a design as an AI needs it and write frames and single layers back. Every
 * value it writes is checked (api/lib/design-check.ts), and a frame that draws a Workshop carousel slide keeps that
 * slide's words: a text layer that says anything else is left out.
 */

const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PICTURE = /^[a-z0-9]{8}\.(jpg|png|webp)$/;
const TYPE: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
/** How many frames an AI is shown at once. */
const LOOK_FRAMES = 6;
/** A look's pictures handed to an AI that asks for it: the ones the person made and liked first. And how many it gets of the person's one look when it asked for none. */
const LOOK_PICTURES = 8;
const LOOK_UNASKED = 4;
/** The longest side of a look's picture as an AI is shown it, when it is not already a small still. */
const LOOK_SIDE = 768;
/** How much of a look's own words an AI is given: in the list of looks a start; of the look it designs in, all of them (a studio's guide runs to a few pages: what they like and hate is rarely in its first lines). */
const LOOK_LISTED = 600;
const LOOK_BRIEF = 6000;

const dirOf = (owner: string) => path.join(env.dataDir, "designs", owner);
const fileOf = (owner: string, id: string) => path.join(dirOf(owner), `${id}.json`);
const picturesOf = (owner: string, id: string) => path.join(dirOf(owner), id);

/** A design as it is kept, every frame with its place and size (one saved before frames had them gets them in a row). */
async function read(owner: string, id: string): Promise<Design | null> {
  if (!USER.test(owner) || !UUID.test(id)) return null;
  try {
    const d = JSON.parse(await readFile(fileOf(owner, id), "utf8")) as Design;
    return { ...d, pages: withFrames(d.pages, d.width, d.height) };
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

/** When a design is changed now: always after its last change, so a window can tell that it has not seen this one (`since`, on a save). */
const stamp = (d: Design): number => Math.max(Date.now(), d.updatedAt + 1);

const summaryOf = (d: Design): DesignSummary => ({ id: d.id, name: d.name, kind: d.kind, format: d.format, width: d.width, height: d.height, pages: d.pages.length, ...(d.from ? { from: d.from } : {}), ...(d.project ? { project: d.project } : {}), updatedAt: d.updatedAt });

/**
 * The designs as the lists show them: each with what it was made from (the Workshop piece's title, the library
 * video's) and its brand project's name, as they are now. A piece's design is in the project its script is in now.
 * The list never fails over a connection: a session that was deleted, a piece that cannot be read and a video that
 * is no longer the person's to read are left out, and the design is listed without them.
 * ponytail: one piece file read for every design made from a piece, at every list; kept by the file's change time
 * when someone has hundreds of them.
 */
async function listed(user: AuthVars["user"], all: readonly Design[]): Promise<DesignListed[]> {
  const projects = new Map((await ownedProjects(user.username).catch(() => [])).map((p) => [p.id, p.name]));
  // a session is read once, however many of its pieces have a design
  const sessions = new Map<string, ReturnType<typeof ownedSession>>();
  const sessionOf = (id: string) => sessions.get(id) ?? sessions.set(id, ownedSession(id, user).catch(() => null)).get(id)!;
  return Promise.all(
    all.map(async (d): Promise<DesignListed> => {
      let madeFrom: string | undefined;
      let project = d.project;
      if (d.from && "session" in d.from) {
        const meta = await sessionOf(d.from.session);
        const piece = meta ? await readDoc(meta.id, d.from.doc).catch(() => null) : null;
        madeFrom = piece?.title || undefined;
        project = meta?.projectId ?? project;
      } else if (d.from) {
        try {
          if (sourcesWorkspace(d.owner, [d.from.version])) madeFrom = (libraryDb().prepare("SELECT a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(d.from.version) as { title?: string } | undefined)?.title || undefined;
        } catch {
          // the library cannot be read right now: the design is listed without its video's name
        }
      }
      const projectName = project ? projects.get(project) : undefined;
      return { ...summaryOf(d), ...(project && projectName ? { project } : {}), ...(madeFrom ? { madeFrom } : {}), ...(projectName ? { projectName } : {}) };
    }),
  );
}

async function addPicture(d: Design, bytes: Buffer, ext: string): Promise<string> {
  const id = `${randomBytes(4).toString("hex")}.${ext}`;
  await mkdir(picturesOf(d.owner, d.id), { recursive: true });
  await writeFile(path.join(picturesOf(d.owner, d.id), id), bytes);
  d.pictures.push(id);
  return id;
}

/** A moment of a library video this account may read, as a JPEG, with the video's title. The frame is copied: a design keeps what it shows, whatever happens to the video. */
async function videoFrame(owner: string, version: string, t: number): Promise<{ frame: Buffer; title: string }> {
  if (!sourcesWorkspace(owner, [version])) throw new DesignError("Not found", 404);
  const row = libraryDb().prepare("SELECT v.source_key, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(version) as { source_key: string; title: string } | undefined;
  if (!row) throw new DesignError("Not found", 404);
  try {
    return { frame: await extractClipJpegFrame({ src: await blobs.localCopy(row.source_key), cacheDir: path.join(dirOf(owner), ".frames"), atMs: Math.round(t * 1000) }), title: row.title };
  } catch (e) {
    throw new DesignError(`That moment of the video could not be read (${e instanceof Error ? e.message : String(e)})`, 502);
  }
}

/** What cannot be done, as the person (or their AI) reads it; `status` is the answer's. */
export class DesignError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502 = 400,
  ) {
    super(message);
  }
}

/** A save by a window that had not seen the design's last change: nothing is written, and it is told the design as it is now. */
class Changed extends Error {
  constructor(readonly design: Design) {
    super("The design was changed somewhere else");
  }
}

interface Slide {
  /** the Workshop block's id */
  id: string;
  words: string;
}

/** The slides of a Workshop carousel piece the caller may see, as words (picture tokens out), with the piece's title. */
async function slidesOf(user: AuthVars["user"], session: string, doc: string): Promise<{ title: string; slides: Slide[]; project?: string }> {
  const meta = await ownedSession(session, user);
  const piece = meta ? await readDoc(meta.id, doc) : null;
  if (!piece) throw new DesignError("Not found", 404);
  if (piece.kind !== "carousel") throw new DesignError("Only a carousel piece has slides to design");
  const slides = piece.blocks.map((b) => ({ id: b.id, words: slideWords(b.text) })).filter((s) => s.words);
  if (!slides.length) throw new DesignError("This carousel has no words yet: write its slides first");
  return { title: piece.title, slides: slides.slice(0, DESIGN_LIMITS.pages), project: meta!.projectId };
}

/**
 * The frames with each slide's frame naming its slide. A design made before frames knew their slides is matched by
 * order, once: the save that follows keeps it, and from then on a frame is its slide's wherever it is moved to.
 */
const matched = (pages: DesignPage[], slides: readonly Slide[]): DesignPage[] => (pages.some((p) => p.block) ? pages : pages.map((p, k) => (slides[k] ? { ...p, block: slides[k]!.id } : p)));

const pieceOf = (d: Design): { session: string; doc: string } | null => (d.from && "session" in d.from ? d.from : null);
const frameLabel = (p: DesignPage, k: number) => `Frame ${k + 1}${p.name ? ` (${p.name})` : ""}`;

/* ---- an AI that designs (the assistant, a connected AI) ---- */

/** How layers are written: what an AI that reads a design is told (GET /:id/pages). */
export const DESIGN_LAYERS = `Every layer has "x", "y", "w", "h" in pixels from its frame's top left corner, and may have "rotate" (degrees about its middle), "flipX" and "flipY" (mirrored), "opacity" (0 to 1), "shadow" ({"color":"#rrggbb","opacity":0.35,"blur":24,"x":0,"y":8}), "blur" (pixels, up to 200: the layer drawn soft, for a glow, a haze, a cloud, something out of focus), "name" (what it is, in a word or two, like "Sun" or "Left palm": the user reads it in their list of layers, so name every layer), "group" (a short name of your choosing, like "palm trees": layers of a frame with the same group are picked and moved as one by the user and stand under that name in their list, so group what belongs together, like a badge and its words) and "blend" (how it mixes with what is under it: ${DESIGN_BLENDS.join(", ")}). Layers are drawn in order, a later one over an earlier one, and are cut at the frame's edges. A "gradient" ({"to":"#rrggbb","angle":90}) on a text, a shape or a frame runs from its own colour to "to": angle 0 is left to right, 90 top to bottom; with "kind":"radial" it runs from the middle out to the corners (a spotlight), and "via":"#rrggbb" is a colour it passes through half-way. The kinds:
- {"type":"text","text":"…","font":"…","size":64,"color":"#rrggbb","align":"left|center|right","valign":"top|middle|bottom","lineHeight":1.15,"spacing":0,"upper":false,"outline":{"color":"#rrggbb","width":8},"gradient":{…}}: "spacing" is pixels between the letters; "fit":"shrink" makes "size" the most, and sets the words at the largest size up to it at which they fit the box (use it whenever you cannot be sure they fit; with a size larger than the box could hold, the words fill the box); "balance":true breaks each paragraph's lines about as long as each other (for headlines); "marks":[{"words":"the floor","color":"#f2b63c"}] lays a highlighter stroke behind those words of the layer, wherever they wrap (leave "words" out for a stroke behind every line), so never place a box behind words yourself; the words wrap inside w, and "\\n" starts a new line (which still wraps when it is too long for w); size is the font size in pixels. "font" is one of "fonts": each is a bold or display face for headlines, except "Poppins Regular" (longer text), "DM Serif Display" (a serif) and "Caveat" (handwriting).
- {"type":"shape","shape":"${DESIGN_SHAPES.join("|")}","fill":"#rrggbb","gradient":{…},"radius":0,"stroke":{"color":"#rrggbb","width":4,"dash":[12,8],"round":false,"side":"inside|outside"}}: a shape fills its box; "radius" rounds a rect's corners, all by one number or each by [top left, top right, bottom right, bottom left] (a picture's too); a stroke's "dash" is [dash, gap] in pixels ([0, gap] with "round" makes dots), and "side" keeps the line inside or outside the shape's edge (left out: half on each side); a triangle points up and an arrow to the right (turn them with "rotate"; "flipX" points the arrow left); a thin rect is a line.
- {"type":"path","points":[{"x":0,"y":1},{"x":0.5,"y":0,"in":[-0.2,0],"out":[0.2,0]},{"x":1,"y":1}],"closed":false,"fill":"#rrggbb","gradient":{…},"stroke":{…}}: a line from point to point, which the user can reshape point by point. "x" and "y" are parts of the layer's box, from 0 to 1, not pixels (0,0 is the box's top left, 1,1 its bottom right); "in" and "out" are the ends of a point's two curve handles, as offsets from it in the same parts (left out: a corner, straight lines). "closed" joins the last point to the first; leave "fill" out for a line alone. A curve between two points: an "out" on the first and an "in" on the second. A marker arrow: one curved path for its shaft and a short V of three points for its head, with the same "group". For a whole illustration a "drawing" is easier.
- {"type":"image","picture":"<id>","fit":"cover|contain","zoom":1,"focus":{"x":0.5,"y":0.5},"radius":0}: only a picture listed under "pictures" (how one gets there is below). "cover" fills the box and cuts the rest off: "focus" says which part stays (0 = the picture's left or top edge, 1 = its right or bottom), "zoom" (1 to 8) goes closer. Its colours: "adjust":{${DESIGN_ADJUST.map((k) => `"${k}":0`).join(",")}} (each -100 to 100), "duotone":{"dark":"#rrggbb","light":"#rrggbb"} (two colours in place of its own; black and white for a black and white picture), "vignette" (1 to 100 darkens the corners, -1 to -100 lightens them), "grain" (0 to 100), "blur" (pixels; a blurred photo behind words keeps them readable). They are settings of the layer, not a changed picture: 0 or null puts one back.
- {"type":"drawing","svg":"<svg viewBox=\\"0 0 100 100\\">…</svg>"}: an illustration of your own, as SVG shapes only: path, rect, circle, ellipse, line, polyline, polygon and g, and defs with linearGradient, radialGradient, stop, clipPath and mask, with plain attributes. No text, image, link, script, style element or filter.`;

const HOW = `A design is a canvas of frames. A frame is one still picture (a carousel slide, a cover, a thumbnail, a post; nothing in it moves, and animation and video are not made here): it has an id, a size (w, h) and layers. The user sees every frame side by side, moves and edits any layer by hand, and exports each frame as a PNG of exactly its size.

${DESIGN_LAYERS}

"looks" are the user's looks: each a collection of pictures they made and liked, and inspirations, with a few words of their own. Design in one of them. Its pictures and all its words ("brief": what the user likes and hates in it) come with this answer when the user has one look, and with "look": its name otherwise: study them before your first change, and carry their finish into the frames (the ground and how it is lit, the type, the materials, the shadows, how much is left empty), never their words or one of them copied. A look's words may also say how its videos move: take from them what a still picture can carry. A design made without a look's pictures comes out generic.

A frame that has "words" draws a slide of the user's carousel: those words are the author's. Place every one of them on that frame, as written: you choose where they go, how big they are and how they are split across text layers, and you never add, drop or change one (to change them, change the piece's slide first). A frame without "words" may say whatever the user asked for or agreed to.

To change a design, give either or both of:
- "frames": [{"id":"<frame id>","background":"#rrggbb","gradient":{…},"layers":[…]}]: that frame's layers are replaced whole (leave "layers" out to change only its background, "gradient", "grain", "vignette", "name", "w" or "h"; "grain" (0 to 100) lays a film grain over the whole frame and "vignette" darkens its edges (1 to 100) or lightens them (-1 to -100): a little of both, with soft shadows and a blurred shape or two, is what gives a flat picture depth; light falling across it from one side is a big blurred ellipse of a warm light colour off that side). Without an "id" it is a new frame of any size: give its "w", "h" and "name" (usual sizes: ${DESIGN_FORMATS.map((f) => `${f.name} ${f.w} × ${f.h}`).join(", ")}). It is laid beside the others (the user moves frames, you do not), and the answer names it with its new id.
- "changes": for one layer at a time, without sending the rest: {"frame":"<id>","layer":"<layer id>","set":{…the fields to change…}}, {"frame":"<id>","layer":"<layer id>","remove":true}, {"frame":"<id>","layer":"<layer id>","order":"front|back"}, or {"frame":"<id>","add":{…a new layer…}} (on top; with "at":"back", under the others). Whatever a change does not name stays as it is, inside "adjust", "shadow" and the like too: {"set":{"adjust":{"warmth":20}}} leaves the other adjustments, and null takes a field off.
- A change {"frame":"<id>","layer":"<a picture layer's id>","cutout":true} takes the picture's background away (the user's own Mac cuts it out, which takes some seconds; the answer says so when no Mac of theirs is on). {"set":{"picture":"<its 'uncut' id>","uncut":null}} puts the background back.
- "picture": {"version":"<a library video's version id, as media_search gives it>","t":<seconds>}: that moment of the video is copied into the design's pictures, and the answer gives its id for an image layer in your next change. The user can also add pictures of their own in the designer.

After a read or a change you are shown the frames as they are drawn, and told when words do not fit their box or are cut off at the frame's edge (nothing said: they fit).

A frame you are designing or redesigning, design in rounds, never in one pass. After each change, set every frame you changed beside the look's pictures (without a look: beside what the user asked for) and name at least three things that make yours look more generic than theirs: type too small or too timid, a flat ground with no light on it, pieces with no weight or shadow, a crowded frame, a highlight on a word that does not carry the point, something there for no reason (a line or a shape that holds or means nothing). Fix them and look again. One slide takes several rounds: stop when you can no longer name a difference that matters. Before you say it is done, look at every frame once more as someone who did not make it would, and fix what gives it away. When the user asks for one change to a frame (a colour, a word, a size, a place), make that change alone with "changes": no rounds, and everything they placed by hand stays where it is.`;

/**
 * The frames as an AI works on them, and each frame's own words (undefined: it is no slide, and may say anything).
 * A carousel piece's design: its frames, a plain frame for each slide written since (so that slide can be designed
 * too), and for each slide's frame the slide's words as the piece has them now.
 */
async function framesForAi(user: AuthVars["user"], d: Design): Promise<{ pages: DesignPage[]; words: (string | undefined)[] }> {
  const piece = pieceOf(d);
  if (!piece) return { pages: d.pages, words: d.pages.map(() => undefined) };
  const { slides } = await slidesOf(user, piece.session, piece.doc);
  const mine = matched(d.pages, slides);
  const drawn = new Set(mine.map((p) => p.block));
  const fresh = slides.filter((s) => !drawn.has(s.id));
  // a slide written since goes beside the rightmost frame, under an id that is its slide's (the same at every read, so
  // the frame an AI read is the frame it then writes)
  const more = plainPages(fresh.map((s) => s.words), d.width, d.height, fresh.map((s) => s.id)).map((p, k) => ({ ...p, x: undefined, y: undefined, id: `s-${fresh[k]!.id}`.slice(0, 24) }));
  const pages = withFrames([...mine, ...more], d.width, d.height).slice(0, DESIGN_LIMITS.pages);
  const bySlide = new Map(slides.map((s) => [s.id, s.words]));
  return { pages, words: pages.map((p) => (p.block ? bySlide.get(p.block) : undefined)) };
}

/** A look as an AI that designs meets it: its name, its brief, how many pictures it has, and those pictures as small JPEGs, the ones made and liked first. */
interface Look {
  id?: string;
  name: string;
  brief: string;
  pictures: number;
  show: (max: number) => Promise<{ jpeg: string; made: boolean }[]>;
}

/** A picture file of any size as a small JPEG; null when it cannot be read. */
async function smallJpeg(file: string): Promise<string | null> {
  const tmp = path.join(env.dataDir, "designs", `.look-${randomBytes(6).toString("hex")}.jpg`);
  try {
    await mkdir(path.dirname(tmp), { recursive: true });
    await ffmpeg(["-y", "-i", file, "-frames:v", "1", "-vf", `scale=w='min(${LOOK_SIDE},iw)':h='min(${LOOK_SIDE},ih)':force_original_aspect_ratio=decrease`, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", tmp], true);
    return (await readFile(tmp)).toString("base64");
  } catch {
    return null;
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * The looks an AI may design in: the account's own animation styles, then the ones a plug-in keeps (a studio's own
 * collections). A plug-in's look named like one of the account's own is left out.
 * ponytail: a plug-in's pictures are made small at every read that shows them (ffmpeg, a few a call); kept by file and
 * change time when that is felt.
 */
async function looksOf(user: AuthVars["user"], owner: string): Promise<Look[]> {
  const own = animationStyles(owner).map((s): Look => ({
    id: s.id,
    name: s.name,
    brief: s.brief,
    pictures: s.pictures.length,
    show: async (max) => {
      const p = await stylePictures(owner, s, max);
      return p.images.map((i, n) => ({ jpeg: i.jpegBase64, made: n < p.made }));
    },
  }));
  const theirs = (await pluginLooks(user)).filter((l) => l.name.trim() && !own.some((o) => o.name.toLowerCase() === l.name.toLowerCase()));
  return [
    ...own,
    ...theirs.map((l): Look => ({
      name: l.name,
      brief: l.brief,
      pictures: l.pictures.length,
      show: async (max) => {
        const out: { jpeg: string; made: boolean }[] = [];
        for (const p of [...l.pictures.filter((x) => x.made), ...l.pictures.filter((x) => !x.made)]) {
          if (out.length >= max) break;
          const jpeg = await smallJpeg(p.file);
          if (jpeg) out.push({ jpeg, made: p.made });
        }
        return out;
      },
    })),
  ];
}

/**
 * What an AI is given to design from: each frame with its size, its words and its layers, the fonts, the pictures,
 * the person's looks in their own words, one look's pictures, and how a design is changed. The look whose pictures it
 * gets: the one it asked for by name; unasked, the person's one look when they have exactly one with pictures (an AI
 * that never asks still designs from it). With several, it is told to pick one and read it first.
 */
async function forAi(user: AuthVars["user"], d: Design, lookNamed: string | undefined) {
  const { pages, words } = await framesForAi(user, d);
  const looks = await looksOf(user, d.owner);
  const pictured = looks.filter((l) => l.pictures > 0);
  const style = lookNamed ? looks.find((s) => s.id === lookNamed || s.name.toLowerCase() === lookNamed.toLowerCase()) : pictured.length === 1 ? pictured[0] : undefined;
  const shown = style ? await style.show(lookNamed ? LOOK_PICTURES : LOOK_UNASKED) : null;
  return {
    id: d.id,
    name: d.name,
    fonts: DESIGN_FONTS.map((f) => f.family),
    pictures: d.pictures.map((id) => ({ id, what: d.from && "version" in d.from && id === d.pictures[0] ? "the video's own frame" : "a picture added to this design" })),
    // a look is its pictures first: its name and brief are what words carry, and its pictures come when it is asked for
    looks: looks.slice(0, 12).map((s) => ({ name: s.name, ...(s.brief.trim() ? { brief: s.brief.trim().slice(0, LOOK_LISTED) } : {}), pictures: s.pictures })),
    ...(lookNamed && !style ? { look: `There is no look called ${lookNamed}` } : {}),
    ...(!lookNamed && pictured.length > 1 ? { look: `Pick the look this design is in (${pictured.slice(0, 12).map((l) => `"${l.name}"`).join(", ")}; ask the user when it is not clear) and read its pictures before you design: design_get with "look": its name.` } : {}),
    ...(style && shown ? { look: { name: style.name, ...(style.brief.trim() ? { brief: style.brief.trim().slice(0, LOOK_BRIEF) } : {}), pictures: shown.map((i) => ({ what: i.made ? "a picture the user made and liked in this look" : "an inspiration for this look", jpeg: i.jpeg })) } } : {}),
    frames: pages.map((p, k) => ({ id: p.id, n: k + 1, ...(p.name ? { name: p.name } : {}), w: p.w, h: p.h, ...(words[k] !== undefined ? { words: words[k] } : {}), background: p.background, ...(p.gradient ? { gradient: p.gradient } : {}), ...(p.grain ? { grain: p.grain } : {}), ...(p.vignette ? { vignette: p.vignette } : {}), layers: p.layers })),
    how: HOW,
  };
}

type Raw = Record<string, unknown>;
const raw = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/**
 * An AI's changes onto the design: whole frames (`frames`) and single layers (`changes`). Every frame they touch
 * goes through the same check as anything else that is saved, with its slide's words held. The answer names what
 * was left out and why, and the frames that changed.
 */
async function writeForAi(user: AuthVars["user"], d: Design, body: Raw): Promise<DesignAnswer & { touched: string[]; wrote: { frame: string; isNew: boolean; layers: string[] }[] }> {
  const frames = Array.isArray(body.frames) ? body.frames.map(raw) : [];
  const changes = Array.isArray(body.changes) ? body.changes.map(raw) : [];
  if (!frames.length && !changes.length) throw new DesignError('Give "frames" (whole frames) or "changes" (single layers): design_get says how each is written');
  const start = await framesForAi(user, d);
  const next = [...start.pages];
  const words = [...start.words];
  const notes: string[] = [];
  /** each touched frame as it will be checked: its raw layers, and what else of it was given */
  const todo = new Map<string, { layers: unknown[]; more: Raw; isNew: boolean; gave: boolean; whole: boolean; set: string[] }>();
  const open = (p: DesignPage) => todo.get(p.id) ?? todo.set(p.id, { layers: [...p.layers], more: {}, isNew: false, gave: false, whole: false, set: [] }).get(p.id)!;

  for (const f of frames.slice(0, DESIGN_LIMITS.pages)) {
    if (!f) continue;
    let page = typeof f.id === "string" ? next.find((p) => p.id === f.id) : undefined;
    if (typeof f.id === "string" && !page) {
      notes.push(`There is no frame ${f.id}: this design's are ${next.map((p) => p.id).join(", ")}`);
      continue;
    }
    if (!page) {
      if (next.length >= DESIGN_LIMITS.pages) {
        notes.push(`A design holds at most ${DESIGN_LIMITS.pages} frames: the new one was not added`);
        continue;
      }
      page = { id: `f${Date.now().toString(36)}${next.length}`, background: "#ffffff", layers: [] };
      next.push(page);
      words.push(undefined);
      open(page).isNew = true;
    }
    const t = open(page);
    if (Array.isArray(f.layers)) {
      t.layers = f.layers;
      t.gave = f.layers.length > 0;
      t.whole = true;
    }
    t.more = { ...t.more, ...f };
  }

  for (const c of changes.slice(0, 200)) {
    const page = c && next.find((p) => p.id === c.frame);
    if (!c || !page) {
      notes.push(`A change names no frame of this design (${String(c?.frame)}): its frames are ${next.map((p) => p.id).join(", ")}`);
      continue;
    }
    const t = open(page);
    const add = raw(c.add);
    if (add) {
      // an id of its own before the frame is checked, so the layers that were there keep theirs
      const ids = new Set(t.layers.map((l) => String(raw(l)?.id)));
      let id = typeof add.id === "string" && !ids.has(add.id) ? add.id : "";
      for (let n = t.layers.length + 1; !id; n++) if (!ids.has(`l${n}`)) id = `l${n}`;
      t.layers = c.at === "back" ? [{ ...add, id }, ...t.layers] : [...t.layers, { ...add, id }];
      t.set.push(id);
      continue;
    }
    const at = t.layers.findIndex((l) => raw(l)?.id === c.layer);
    if (at < 0) {
      notes.push(`${frameLabel(page, next.indexOf(page))} has no layer ${String(c.layer)}`);
      continue;
    }
    const [layer] = t.layers.splice(at, 1);
    if (c.remove === true) continue;
    t.set.push(String(c.layer));
    // a field that is itself a set of fields ("adjust", "shadow", "gradient") takes the ones given and keeps the rest; null takes it off whole
    const was = layer as Raw;
    const changed = raw(c.set) ? { ...was, ...Object.fromEntries(Object.entries(c.set as Raw).map(([k, v]) => [k, raw(v) && raw(was[k]) ? { ...raw(was[k]), ...raw(v) } : v])), id: was.id } : layer;
    if (c.order === "front") t.layers.push(changed);
    else if (c.order === "back") t.layers.unshift(changed);
    else t.layers.splice(at, 0, changed);
  }

  const touched: string[] = [];
  const wrote: { frame: string; isNew: boolean; layers: string[] }[] = [];
  for (const [id, t] of todo) {
    const k = next.findIndex((p) => p.id === id);
    const was = next[k]!;
    const label = frameLabel(was, k);
    const made = cleanPages([{ id, layers: t.layers, w: typeof t.more.w === "number" ? t.more.w : was.w, h: typeof t.more.h === "number" ? t.more.h : was.h, background: t.more.background ?? was.background, gradient: "gradient" in t.more ? t.more.gradient : was.gradient, grain: "grain" in t.more ? t.more.grain : was.grain, vignette: "vignette" in t.more ? t.more.vignette : was.vignette, name: t.more.name ?? was.name }], {
      w: d.width,
      h: d.height,
      pictures: d.pictures,
      words: [words[k]],
    });
    notes.push(...made.notes.map((note) => note.replace(/^Page 1:/, `${label}:`)));
    const page = made.pages[0]!;
    // layers were given and none of them could be drawn: the frame is as it was (a new one stays, empty)
    if (t.gave && !page.layers.length && !t.isNew) {
      notes.push(`${label}: nothing given could be drawn, so it is as it was`);
      continue;
    }
    // its place on the canvas and its slide are not the AI's to move
    next[k] = { ...page, ...(was.x !== undefined ? { x: was.x, y: was.y } : {}), ...(was.block ? { block: was.block } : {}) };
    touched.push(id);
    // the layers this wrote: all of a frame given whole, else the ones set and the ones added
    const had = new Set(was.layers.map((l) => l.id));
    wrote.push({ frame: id, isNew: t.isNew, layers: page.layers.filter((l) => t.whole || t.isNew || t.set.includes(l.id) || !had.has(l.id)).map((l) => l.id) });
  }
  if (!touched.length) throw new DesignError(`Nothing was changed${notes.length ? `: ${notes.slice(0, 4).join("; ")}` : ""}`);
  // onto the design as it is now on disk: a frame this did not touch is as the person has it, and one they moved
  // meanwhile keeps the place they gave it
  const now = (await read(d.owner, d.id)) ?? d;
  const pages = withFrames(
    next.map((p) => {
      const there = now.pages.find((x) => x.id === p.id);
      if (!there) return p;
      return touched.includes(p.id) ? { ...p, x: there.x, y: there.y } : there;
    }),
    d.width,
    d.height,
  );
  return { design: await save({ ...now, pages, updatedAt: stamp(now) }), notes, touched, wrote };
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
    if (e instanceof Changed) return c.json({ error: e.message, design: e.design }, 409);
    throw e;
  }
};
const body = async (c: C) => ((await c.req.json().catch(() => null)) ?? {}) as Raw;
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
    return listed(
      c.get("user"),
      all.filter((d) => !session || !doc || (pieceOf(d)?.session === session && pieceOf(d)?.doc === doc)).sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }),
);

designsApp.post("/", (c) =>
  answer(c, async () => {
    const user = c.get("user");
    const b = await body(c);
    const format = formatOf(b.format);
    if (!format) throw new DesignError("Pick one of the picture sizes");
    const have = (await readdir(dirOf(user.username)).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).length;
    if (have >= DESIGN_LIMITS.designs) throw new DesignError(`An account holds up to ${DESIGN_LIMITS.designs} designs: delete one first`);
    const now = Date.now();
    const d: Design = { id: randomUUID(), owner: user.username, name: "Untitled design", kind: format.kind, format: format.id, width: format.w, height: format.h, pages: [], pictures: [], createdAt: now, updatedAt: now };
    const named = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, DESIGN_LIMITS.name) : "";
    if (typeof b.session === "string" && typeof b.doc === "string") {
      if (format.kind !== "carousel") throw new DesignError("A carousel's slides take a carousel size");
      const { title, slides, project } = await slidesOf(user, b.session, b.doc);
      d.name = named || title.slice(0, DESIGN_LIMITS.name) || d.name;
      d.from = { session: b.session, doc: b.doc };
      // its script's project
      if (project) d.project = project;
      d.pages = plainPages(slides.map((s) => s.words), d.width, d.height, slides.map((s) => s.id));
    } else if (typeof b.version === "string" && typeof b.t === "number" && Number.isFinite(b.t) && b.t >= 0) {
      if (format.kind === "carousel") throw new DesignError("A video's frame takes the cover or the thumbnail size");
      const { frame, title: videoTitle } = await videoFrame(user.username, b.version, b.t);
      const title = typeof b.title === "string" ? b.title : "";
      d.name = named || (title.trim() || videoTitle).slice(0, DESIGN_LIMITS.name);
      d.from = { version: b.version, t: b.t };
      d.pages = [coverPage(await addPicture(d, frame, "jpg"), title, d.width, d.height)];
    } else if (b.blank === true) {
      // a design of its own: empty frames to draw on (one when it does not say; `pages: 0` is an empty canvas, its frames made on it)
      const count = Number.isInteger(b.pages) ? Math.min(DESIGN_LIMITS.pages, Math.max(0, b.pages as number)) : 1;
      d.name = named || d.name;
      d.pages = withFrames(Array.from({ length: count }, (_, k) => ({ id: `p${k + 1}`, background: "#ffffff", layers: [] })), d.width, d.height);
    } else throw new DesignError("Say what the design is of: a carousel piece (session and doc), a video's moment (version and t), or blank: true");
    // made on its own, or from a video: in the brand project the window is in when that is the person's own, else the
    // account's current one (the way a Workshop session gets its project)
    if (!pieceOf(d)) {
      const project = await resolveProjectId(user, typeof b.project === "string" ? b.project : null).catch(() => undefined);
      if (project) d.project = project;
    }
    return save(d);
  }),
);

designsApp.get("/:id", (c) => answer(c, () => mine(c)));

designsApp.put("/:id", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    const b = await body(c);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, DESIGN_LIMITS.name) : d.name;
    if (!Array.isArray(b.pages)) return save({ ...d, name, updatedAt: stamp(d) });
    // `since`: the design's last change this window knows of. One made after it (an AI's frames, written while this
    // save was on its way) would be written over by frames that never saw it: the window puts its own changes onto
    // the design as it is now, and saves again
    if (typeof b.since === "number" && d.updatedAt > b.since) throw new Changed(d);
    // the person's own changes: checked for what a frame can hold, never for whose words they are. A frame sent
    // without its place (a window opened before frames had one) keeps the place and the slide it has
    const piece = pieceOf(d);
    // a design made before frames knew their slides: each frame is its slide's by the order the design was in
    const was = piece && !d.pages.some((p) => p.block) ? matched(d.pages, await slidesOf(c.get("user"), piece.session, piece.doc).then((s) => s.slides, () => [])) : d.pages;
    const pages = withFrames(cleanPages(b.pages, { w: d.width, h: d.height, pictures: d.pictures }).pages, d.width, d.height, was);
    // no frames sent is the person's own doing (the last frame deleted: an empty canvas); frames sent of which none
    // could be kept is not, and nothing is saved over what is there
    if (!pages.length && !(Array.isArray(b.pages) && !b.pages.length)) throw new DesignError("None of the frames sent could be kept");
    return save({ ...d, name, pages, updatedAt: stamp(d) });
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

// an AI that designs: what it reads (?look=<a look's name> adds that look's pictures), and what it writes
designsApp.get("/:id/pages", (c) => answer(c, async () => forAi(c.get("user"), await mine(c), c.req.query("look")?.trim() || undefined)));
designsApp.post("/:id/pages", (c) => answer(c, async () => writeForAi(c.get("user"), await mine(c), await body(c))));
// what it made, to look at: the frames named in ?frames=<id>,<id> (else the first ones) as small pictures, with the words that do not fit
designsApp.get("/:id/look", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    const { pages } = await framesForAi(c.get("user"), d);
    const asked = (c.req.query("frames") ?? "").split(",").map((id) => pages.findIndex((p) => p.id === id) + 1).filter((n) => n > 0);
    return pagePictures(d, pages, [...new Set(asked.length ? asked : pages.map((_, k) => k + 1))].slice(0, LOOK_FRAMES), picturesOf(d.owner, d.id));
  }),
);

designsApp.post("/:id/pictures", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    if (d.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: take one out first`);
    const b = await body(c);
    let id: string;
    if (typeof b.version === "string" && typeof b.t === "number" && Number.isFinite(b.t) && b.t >= 0) {
      // a moment of a library video (an AI that designs has no file to send): copied in like any other picture
      id = await addPicture(d, (await videoFrame(d.owner, b.version, b.t)).frame, "jpg");
    } else {
      let sent: ReturnType<typeof parsePictureUpload>;
      try {
        sent = parsePictureUpload(b);
      } catch (e) {
        throw new DesignError(e instanceof Error ? e.message : String(e));
      }
      id = await addPicture(d, sent.bytes, PICTURE_EXT[sent.type]);
    }
    await save({ ...d, updatedAt: stamp(d) });
    return { id };
  }),
);

/** The longest side a cut-out is kept at when it comes back too heavy to keep whole: more than any frame shows. */
const CUT_SIDE = 2560;

// A picture of the design with its background taken away, as a new picture of the design (the first one stays: the
// layer that shows the cut-out names it, so the background can be put back). The cutting is done by a Mac of the
// person's own (lib/cutouts.ts): nothing leaves their machines, and without such a Mac the answer says what is missing.
designsApp.post("/:id/pictures/:pid/cutout", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    const pid = c.req.param("pid");
    if (!PICTURE.test(pid) || !d.pictures.includes(pid)) throw new DesignError("Not found", 404);
    if (d.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: take one out first`);
    const dir = picturesOf(d.owner, d.id);
    const tmp = path.join(dir, `.cut-${randomBytes(6).toString("hex")}.png`);
    try {
      // a WebP is not a picture the Mac takes: it goes as a PNG
      let bytes = await readFile(path.join(dir, pid));
      if (pid.endsWith(".webp")) {
        await ffmpeg(["-y", "-i", path.join(dir, pid), "-frames:v", "1", "-f", "image2", "-c:v", "png", tmp], true);
        bytes = await readFile(tmp);
      }
      let cut: Buffer;
      try {
        cut = await cutOut(d.owner, bytes);
      } catch (e) {
        throw new DesignError(e instanceof Error ? e.message : String(e));
      }
      // a cut-out is a PNG, often several times its photo's weight: one over the cap for a picture is kept smaller
      if (cut.length > DESIGN_LIMITS.pictureBytes) {
        const whole = `${tmp}.whole.png`;
        await writeFile(whole, cut);
        await ffmpeg(["-y", "-i", whole, "-frames:v", "1", "-vf", `scale=w='min(${CUT_SIDE},iw)':h='min(${CUT_SIDE},ih)':force_original_aspect_ratio=decrease`, "-f", "image2", "-c:v", "png", tmp], true).finally(() => rm(whole, { force: true }));
        cut = await readFile(tmp);
        if (cut.length > 2 * DESIGN_LIMITS.pictureBytes) throw new DesignError("The cut-out is too heavy to keep in a design");
      }
      // onto the design as it is now: the cutting took a while, and a hand or an AI may have changed it meanwhile
      const now = (await read(d.owner, d.id)) ?? d;
      const id = await addPicture(now, cut, "png");
      await save({ ...now, updatedAt: stamp(now) });
      return { id };
    } finally {
      await rm(tmp, { force: true });
    }
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
