import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { DESIGN_ADJUST, DESIGN_BLENDS, DESIGN_HEADS, DESIGN_FORMATS, DESIGN_GAP, DESIGN_PINS_X, DESIGN_PINS_Y, DESIGN_LIMITS, DESIGN_SAFE, DESIGN_SHAPES, formatOf, type Design, type DesignAnswer, type DesignFont, type DesignListed, type DesignPage, type DesignSummary, type Layer, type SplitAnswer, type TextLayer } from "../contracts/design";
import { DESIGN_FONTS, weightsOf } from "../src/lib/design/fonts";
import { fillRow, placeLayers, sizedCopy, type Placed } from "../src/lib/design/resize";
import { retext } from "../src/lib/design/runs";
import type { AuthVars } from "./auth";
import type { AnimationStyle } from "../contracts/editor-styles";
import { animationStyles, carouselApp, carouselStyles } from "./editor/animation-styles";
import { stylePictures } from "./editor/cards/step";
import { sourcesWorkspace } from "./editor/store";
import { frameAt, pictureInto } from "./lib/clip-frame";
import { cutOut, NoMac, splitPicture } from "./lib/cutouts";
import { cleanPages, coverPage, inWords, plainPages, slideWords, withFrames } from "./lib/design-check";
import { pagePictures } from "./lib/design-picture";
import { smallJpeg } from "./lib/small-jpeg";
import { FontError, fontFaces } from "./lib/font-file";
import { env } from "./lib/env";
import { pluginLooks } from "./lib/plugin";
import { PICTURE_EXT, parsePictureUpload } from "./lib/workshop/pictures";
import { blobs, libraryDb } from "./library/db";
import { ownedProjects, resolveProjectId } from "./lib/workshop/workspace";
import { inCurrentWorkspace } from "./lib/workspace-scope";
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

/* ---- the person's own fonts: $DATA_DIR/designs/<owner>/.fonts/<id>.ttf|otf, and index.json beside them ---- */

interface KeptFont extends DesignFont {
  ext: "ttf" | "otf";
  at: number;
}
const FONT_ID = /^[0-9a-f]{16}$/;
/** A layer's id as design-check keeps it. */
const LAYER_ID = /^[a-z0-9-]{1,24}$/;
const fontsDir = (owner: string) => path.join(dirOf(owner), ".fonts");
const fontFile = (owner: string, f: Pick<KeptFont, "id" | "ext">) => path.join(fontsDir(owner), `${f.id}.${f.ext}`);

/**
 * The person's own fonts, oldest first. None added yet: none. A list that is there and cannot be read is an error,
 * never "none": a caller that took it for none would offer an AI no font of theirs and tell the page they are gone.
 */
async function fontsOf(owner: string): Promise<KeptFont[]> {
  let text: string;
  try {
    text = await readFile(path.join(fontsDir(owner), "index.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const list: unknown = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error(`The fonts list of ${owner} is not a list`);
  return (list as KeptFont[]).filter((f) => f && FONT_ID.test(f.id) && typeof f.family === "string" && (f.ext === "ttf" || f.ext === "otf"));
}

async function keepFonts(owner: string, list: KeptFont[]): Promise<void> {
  await mkdir(fontsDir(owner), { recursive: true });
  const file = path.join(fontsDir(owner), "index.json");
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(list));
  await rename(tmp, file);
}

// one change to a person's fonts at a time: two files added at once would each write the list without the other's
const fontTurn = new Map<string, Promise<unknown>>();
function inTurn<T>(owner: string, run: () => Promise<T>): Promise<T> {
  const mine = (fontTurn.get(owner) ?? Promise.resolve()).then(run, run);
  fontTurn.set(owner, mine.catch(() => {}));
  return mine;
}

/**
 * The fonts a design's words may be set in beside the app's own: the person's own, and the ones its words are set in
 * already. So a font that was taken away stays named in the layers that use it (and is drawn again once it is back),
 * while a name an AI makes up is still turned into a face that is there.
 */
async function fontsFor(d: Design): Promise<string[]> {
  return [...new Set([...(await fontsOf(d.owner)).map((f) => f.family), ...d.pages.flatMap((p) => p.layers.flatMap((l) => (l.type === "text" ? [l.font] : [])))])];
}

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

const summaryOf = (d: Design): DesignSummary => ({ id: d.id, name: d.name, kind: d.kind, format: d.format, width: d.width, height: d.height, pages: d.pages.filter((p) => !p.loose).length, ...(d.from ? { from: d.from } : {}), ...(d.project ? { project: d.project } : {}), updatedAt: d.updatedAt });

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

async function addPicture(d: Design, bytes: Buffer, ext: string, given?: unknown): Promise<string> {
  // the id the window gave it (it shows the picture before it is here), when it is one and not taken
  const id = typeof given === "string" && PICTURE.test(given) && given.endsWith(`.${ext}`) && !d.pictures.includes(given) ? given : `${randomBytes(4).toString("hex")}.${ext}`;
  if (given !== undefined && id !== given) throw new DesignError("That picture id cannot be used");
  await mkdir(picturesOf(d.owner, d.id), { recursive: true });
  await writeFile(path.join(picturesOf(d.owner, d.id), id), bytes);
  d.pictures.push(id);
  return id;
}

/** A moment of a library video this account may read, as a JPEG, with the video's title. The frame is copied: a design keeps what it shows, whatever happens to the video. */
async function videoFrame(owner: string, version: string, t: number): Promise<{ frame: Buffer; title: string }> {
  const ws = sourcesWorkspace(owner, [version]);
  if (!ws) throw new DesignError("Not found", 404);
  const row = libraryDb().prepare("SELECT v.source_key, v.mac_path, v.mac_device, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(version) as { source_key: string; mac_path: string | null; mac_device: string | null; title: string } | undefined;
  if (!row) throw new DesignError("Not found", 404);
  const ms = Math.round(t * 1000);
  const frames = path.join(dirOf(owner), ".frames");
  let got: Awaited<ReturnType<typeof frameAt>>;
  try {
    // the server's copy when it has one; else the computer that holds the original makes it
    const src = await blobs.localCopy(row.source_key).catch(() => undefined);
    got = await frameAt(`design:${owner}:${version}:${ms}`, owner, ws, { files: { src }, ...(row.mac_path ? { paths: { src: row.mac_path }, device: row.mac_device ?? undefined } : {}), atMs: ms, to: path.join(frames, `${version}-${ms}.jpg`), prune: frames }, true);
  } catch (e) {
    throw new DesignError(`That moment of the video could not be read (${e instanceof Error ? e.message : String(e)})`, 502);
  }
  // asked again once it is made, it is here at once
  if ("wait" in got) throw new DesignError(got.wait, 409, { code: "waiting" });
  return { frame: got.jpeg, title: row.title };
}

/** What cannot be done, as the person (or their AI) reads it; `status` is the answer's. */
export class DesignError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
    /** more the answer carries beside `error` */
    readonly more?: Record<string, unknown>,
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
const matched = (pages: DesignPage[], slides: readonly Slide[]): DesignPage[] => (pages.some((p) => p.block) ? pages : pages.map((p, k) => (slides[k] && !p.loose ? { ...p, block: slides[k]!.id } : p)));

/**
 * The layers lying on the canvas outside every frame, as an AI sees them: one list, in the canvas's own pixels, each
 * with an id of its own among them (the same at every read). `home`: the loose piece it lies in, `real`: its id there.
 */
export function canvasLayers(pages: readonly DesignPage[]): { home: string; real: string; layer: Layer }[] {
  const taken = new Set<string>();
  return pages
    .filter((p) => p.loose)
    .flatMap((p) =>
      p.layers.map((l) => {
        let id = l.id;
        for (let n = 1; taken.has(id); n++) id = `c${n}`;
        taken.add(id);
        return { home: p.id, real: l.id, layer: { ...l, id, x: l.x + (p.x ?? 0), y: l.y + (p.y ?? 0) } };
      }),
    );
}

const pieceOf = (d: Design): { session: string; doc: string } | null => (d.from && "session" in d.from ? d.from : null);

/* ---- an AI that designs (the assistant, a connected AI) ---- */

/** How layers are written: what an AI that reads a design is told (GET /:id/pages). */
export const DESIGN_LAYERS = `Every layer has "x", "y", "w", "h" in pixels from its frame's top left corner, and may have "rotate" (degrees about its middle), "flipX" and "flipY" (mirrored), "opacity" (0 to 1), "effects" (a list, bottom first; "hidden":true keeps one without drawing it): {"type":"shadow","color":"#rrggbb","opacity":0.35,"blur":24,"x":0,"y":8,"spread":0} falls under it ("spread" in pixels grows it, below 0 shrinks it; several make depth: a long soft one at low opacity over a tight dark one; "blur":0 with a "spread" and an offset is a hard sticker shadow), {"type":"inner-shadow",…the same} lies inside its edges (a pressed button, an inset), {"type":"blur","blur":24} draws it soft (pixels, up to 200: a glow, a haze, a cloud, something out of focus), {"type":"progressive-blur","blur":40,"from":0.5,"to":1,"angle":90} leaves it sharp up to "from" and fully blurred from "to" (parts of its box along the angle: 90 is top to bottom), its edges kept (a photo going soft where words sit), {"type":"background-blur","blur":30} blurs what lies under it, inside its shape (frosted glass: a light or dark shape at opacity 0.2 to 0.5 over a photo, words on it), {"type":"noise","amount":12,"size":2} grain on the layer itself (1 to 100, grains "size" pixels across). With "effects" given, the old "shadow" ({"color":"#rrggbb","opacity":0.35,"blur":24,"x":0,"y":8}) and "blur" (pixels, up to 200) of a layer are not read: they still work alone. "name" (what it is, in a word or two, like "Sun" or "Left palm": the user reads it in their list of layers, so name every layer), "group" (a short name of your choosing, like "palm trees": layers of a frame with the same group are picked and moved as one by the user and stand under that name in their list, so group what belongs together, like a badge and its words) "blend" (how it mixes with what is under it: ${DESIGN_BLENDS.join(", ")}) and "pin" (how it follows the frame's edges when the frame changes size: {"x":"${DESIGN_PINS_X.join("|")}","y":"${DESIGN_PINS_Y.join("|")}"}; "both" keeps it at both edges, so it stretches; "scale" keeps its share of the frame; a layer without a pin stays where it is when the frame grows, and keeps its share of the frame in a copy of another size: pin a handle in a corner, a footer to the bottom, a background to both). Layers are drawn in order, a later one over an earlier one, and are cut at the frame's edges. A "gradient" ({"to":"#rrggbb","angle":90}) on a text, a shape or a frame runs from its own colour to "to": angle 0 is left to right, 90 top to bottom; with "kind":"radial" it runs from the middle out to the corners (a spotlight), and "via":"#rrggbb" is a colour it passes through half-way. Colours are "#rrggbb", or "#rrggbbaa" where the last two digits say how solid it is ("#00000099" is a 60 % black scrim). For more than one fill or line, a text, a shape, a path or a frame takes "fills" in place of its colour and "gradient", and a text, a shape, a path, a picture or a frame takes "strokes" in place of "stroke" (a text's in place of "outline"), each a list drawn bottom first: a fill is {"type":"solid","color":"#rrggbbaa"}, {"type":"gradient","kind":"linear|radial|angular|diamond","angle":90,"stops":[{"at":0,"color":"#rrggbb"},{"at":0.6,"color":"#rrggbb"},{"at":1,"color":"#rrggbb00"}]} (any number of stops, "at" 0 to 1; angular turns round the middle from "angle", diamond and radial run from the middle out to the corners) or {"type":"image","picture":"<id>","mode":"fill|fit|crop|tile","crop":{"x":0.1,"y":0,"w":0.5,"h":0.5},"scale":0.25} (a picture under "pictures" inside a shape or the letters of a text; "crop" is the part of the picture shown, in parts of it; "scale" is one tile's width as a part of the layer's); a stroke is a "stroke" as below, also with "cap":"butt|round|square", "join":"miter|round|bevel", "sides":[top,right,bottom,left] (widths a side, on a rect, a picture or a frame: [0,0,6,0] is a bar under it), and on an open path "start"/"end":"${DESIGN_HEADS.join("|")}" (an arrow line). Every fill and stroke may have "opacity" (0 to 1), "blend" and "hidden":true. A double outline (sticker letters) is two strokes, the wider under the narrower. A rect or a picture may have "smooth" (0 to 1): its rounded corners run softly into the sides. The kinds:
- {"type":"text","text":"…","font":"…","size":64,"color":"#rrggbb","align":"left|center|right","valign":"top|middle|bottom","lineHeight":1.15,"spacing":0,"upper":false,"outline":{"color":"#rrggbb","width":8},"gradient":{…}}: "spacing" is pixels between the letters; "fit":"shrink" makes "size" the most, and sets the words at the largest size up to it at which they fit the box (use it whenever you cannot be sure they fit; with a size larger than the box could hold, the words fill the box); "lines":2 does the same and also keeps them to at most that many lines, with no word left alone on a last line (for headlines, titles and any short text that must not end on one word); "balance":true breaks each paragraph's lines about as long as each other (for headlines); "marks":[{"words":"the floor","color":"#f2b63c"}] lays a highlighter stroke behind those words of the layer, wherever they wrap (leave "words" out for a stroke behind every line), so never place a box behind words yourself. A stroke is flat ink with square ends and no shadow; with "low":true it sits low, over the small letters and a little under the line with the tall letters standing out of it, the way a marker is drawn through a line; the words wrap inside w, and "\\n" starts a new line (which still wraps when it is too long for w); size is the font size in pixels. "font" is one of "fonts": each is a bold or display face for headlines, except "Poppins Regular" (longer text), "DM Serif Display" (a serif) and "Caveat" (handwriting). "weight" (100–900) sets it in another weight of its family: the ones it has are in "weights" (a font not there has only its own). "italic":true slants it, "underline":true and "strike":true draw a line under or through it, "case":"upper|lower|title|small" sets the letters' case (small: small capitals). "runs" sets part of the words apart without another layer: [{"words":"€49","strike":true,"color":"#888888"},{"start":0,"end":4,"weight":800,"size":120}], each with "words" (every place that phrase is in the text) or "start"/"end" (letters of "text", the end not included), and any of "font", "weight", "italic", "size", "color", "underline", "strike", "spacing"; what a run leaves out is the layer's. A highlighter's "marks" work across runs.
- {"type":"shape","shape":"${DESIGN_SHAPES.join("|")}","fill":"#rrggbb","gradient":{…},"radius":0,"stroke":{"color":"#rrggbb","width":4,"dash":[12,8],"round":false,"side":"inside|outside"}}: a shape fills its box; "radius" rounds a rect's corners, all by one number or each by [top left, top right, bottom right, bottom left] (a picture's too); a stroke's "dash" is [dash, gap] in pixels ([0, gap] with "round" makes dots), and "side" keeps the line inside or outside the shape's edge (left out: half on each side); a triangle points up and an arrow to the right (turn them with "rotate"; "flipX" points the arrow left); a thin rect is a line.
- {"type":"path","points":[{"x":0,"y":1},{"x":0.5,"y":0,"in":[-0.2,0],"out":[0.2,0]},{"x":1,"y":1}],"closed":false,"fill":"#rrggbb","gradient":{…},"stroke":{…}}: a line from point to point, which the user can reshape point by point. "x" and "y" are parts of the layer's box, from 0 to 1, not pixels (0,0 is the box's top left, 1,1 its bottom right); "in" and "out" are the ends of a point's two curve handles, as offsets from it in the same parts (left out: a corner, straight lines). "closed" joins the last point to the first; leave "fill" out for a line alone. A curve between two points: an "out" on the first and an "in" on the second. A marker arrow: one curved path for its shaft and a short V of three points for its head, with the same "group". For a whole illustration a "drawing" is easier.
- {"type":"image","picture":"<id>","fit":"cover|contain","zoom":1,"focus":{"x":0.5,"y":0.5},"radius":0}: only a picture listed under "pictures" (how one gets there is below). "cover" fills the box and cuts the rest off: "focus" says which part stays (0 = the picture's left or top edge, 1 = its right or bottom), "zoom" (1 to 8) goes closer. Its colours: "adjust":{${DESIGN_ADJUST.map((k) => `"${k}":0`).join(",")}} (each -100 to 100), "duotone":{"dark":"#rrggbb","light":"#rrggbb"} (two colours in place of its own; black and white for a black and white picture), "vignette" (1 to 100 darkens the corners, -1 to -100 lightens them), "grain" (0 to 100), "blur" (pixels; a blurred photo behind words keeps them readable). They are settings of the layer, not a changed picture: 0 or null puts one back.
- {"type":"drawing","svg":"<svg viewBox=\\"0 0 100 100\\">…</svg>"}: an illustration of your own, as SVG shapes only: path, rect, circle, ellipse, line, polyline, polygon and g, and defs with linearGradient, radialGradient, stop, clipPath and mask, with plain attributes. No text, image, link, script, style element or filter.`;

const HOW = `A design is a canvas of frames. A frame is one still picture (a carousel slide, a cover, a thumbnail, a post; nothing in it moves, and animation and video are not made here): it has an id, a size (w, h) and layers. The user sees every frame side by side, moves and edits any layer by hand, and exports each frame as a PNG of exactly its size.

${DESIGN_LAYERS}

"looks" are the user's looks: each a collection of pictures they made and liked, and inspirations, with a few words of their own. A "carousel style" is made for these frames: design in one of them. An "animation style" is how the cards in the user's videos look: design in one when the user names it, or as "look" says. A look's pictures and all its words ("brief": what the user likes and hates in it) come with this answer when the user has one carousel style, and with "look": its name otherwise: study them before your first change, and carry their finish into the frames (the ground and how it is lit, the type, the materials, the shadows, how much is left empty), never their words or one of them copied. A look's words may also say how its videos move: take from them what a still picture can carry. A design made without a look's pictures comes out generic.

A frame that has "words" draws a slide of the user's carousel: those words are the author's. Place every one of them on that frame, as written: you choose where they go, how big they are and how they are split across text layers, and you never add, drop or change one (to change them, change the piece's slide first). A frame without "words" may say whatever the user asked for or agreed to.

To change a design, give either or both of:
- "frames": [{"id":"<frame id>","background":"#rrggbb","gradient":{…},"layers":[…]}]: that frame's layers are replaced whole (leave "layers" out to change only its background, "gradient", "grain", "vignette", "name", "w" or "h"; "grain" (0 to 100) lays a film grain over the whole frame and "vignette" darkens its edges (1 to 100) or lightens them (-1 to -100): a little of both, with soft shadows and a blurred shape or two, is what gives a flat picture depth; light falling across it from one side is a big blurred ellipse of a warm light colour off that side). Without an "id" it is a new frame of any size: give its "w", "h" and "name" (usual sizes: ${DESIGN_FORMATS.map((f) => `${f.name} ${f.w} × ${f.h}`).join(", ")}). It is laid beside the others (the user moves frames, you do not), and the answer names it with its new id; give it "as":"<a name of yours>" and the changes in the same call use that name as its "frame".
- A frame's aids, set like its background (shown to the user on the canvas, never in the PNG): "guides":[{"axis":"x|y","at":<pixels from the frame's left (x: an up-and-down line) or top (y)>}], "grids":[{"kind":"columns|rows","count":4,"gutter":24,"margin":80,"color":"#ff0000"} or {"kind":"grid","size":8,"color":"#ff0000"}] (layout grids) and "safe":[${DESIGN_SAFE.map((z) => `"${z.id}"`).join(",")}] (where Instagram cuts or covers the frame: ${DESIGN_SAFE.map((z) => `${z.id} = ${z.name.toLowerCase()}`).join(", ")}). Layers the user moves catch on guides and grids. Keep words and faces out of a frame's covered parts; [] takes a list off.
- "changes": for one layer at a time, without sending the rest: {"frame":"<id>","layer":"<layer id>","set":{…the fields to change…}}, {"frame":"<id>","layer":"<layer id>","remove":true}, {"frame":"<id>","layer":"<layer id>","order":"front|back"}, or {"frame":"<id>","add":{…a new layer…},"as":"<a name of yours>"} (on top; with "at":"back", under the others; a later change in the same call names it by "as" as its "layer", and "named" in the answer gives the id a name became when it is another). The layers already there keep their ids whatever is added, removed or reordered. Whatever a change does not name stays as it is, inside "adjust", "shadow" and the like too: {"set":{"adjust":{"warmth":20}}} leaves the other adjustments, and null takes a field off. A list ("effects", "marks", "points") is replaced whole.
- "canvas" (in this answer when there is any): layers lying on the canvas outside every frame, where the user keeps things aside. Their "x" and "y" are in the canvas's own pixels, as each frame's "x" and "y" are; they are in no PNG and in no picture of a frame you are shown. A change with "frame":"canvas" sets, adds (give "x", "y", "w" and "h"), removes or reorders one of them as on a frame. {"frame":"<a frame's id or canvas>","layer":"<layer id>","to":"<another frame's id or canvas>"} moves that layer there, staying where it is on the canvas (it leaves its group); a "set" in the same change then places it, its "x" and "y" counted from that frame's top left corner (on the canvas: in the canvas's pixels). A frame with "clip":false shows the parts of its layers past its edges on the canvas (never in its PNG); without it they are hidden.
- A change {"frame":"<id>","layer":"<a picture layer's id>","cutout":true} takes the picture's background away (the user's own Mac cuts it out, which takes some seconds; the answer says so when no Mac of theirs is on). {"set":{"picture":"<its 'uncut' id>","uncut":null}} puts the background back.
- "sizes": {"frames":["<frame id>",…],"to":["square","cover",{"name":"Feed","w":1080,"h":1350}]}: a copy of each frame (all of them without "frames") in each size, its layers placed by their pins and words set again to fit (a text with "fit":"shrink" fits itself). "to" takes ${DESIGN_FORMATS.map((f) => `"${f.id}" (${f.w} × ${f.h})`).join(", ")} or any {"w","h"}. The copies go under the frames, a row a size. One call turns a carousel into its feed, story and square sizes.
- "fill": {"frame":"<frame id>","rows":[{"name":"02 Proof","Headline":"…","Badge":{"visible":false}},…],"sizes":[…as in "sizes"…]}: one copy of that frame a row, in a row to its right (with "sizes": one a size, under each other). Each key of a row names layers by their "name" and gives a text's words, or {"text":"…","visible":true|false,"color":"#rrggbb"}; "name" names the copy. Name the layers to fill first.
- "picture": {"version":"<a library video's version id, as media_search gives it>","t":<seconds>}: that moment of the video is copied into the design's pictures, and the answer gives its id for an image layer in your next change. The user can also add pictures of their own in the designer.

Changes are made in the order given: "frames", then "changes", then "sizes" and "fill" (which may name a frame made in the same call by its "as"). One that cannot be made is left out and the rest are made: "notes" names each by where it was given ("changes[3]", "frames[0].layers[2]", "sizes.to[1]", "fill.rows"), its frame and layer, and why, so send that one again fixed, never the whole call.

After a read or a change you are shown the frames as they are drawn, and told when words do not fit their box or are cut off at the frame's edge (nothing said: they fit), and the size a text that shrinks is drawn at ("as_drawn"): its own "size" stays the most it may be, so leave it.

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
  // the layers lying loose beside the frames come after them, and are never cut off by the frames' limit
  const pages = [...withFrames([...mine.filter((p) => !p.loose), ...more], d.width, d.height).slice(0, DESIGN_LIMITS.pages), ...mine.filter((p) => p.loose)];
  const bySlide = new Map(slides.map((s) => [s.id, s.words]));
  return { pages, words: pages.map((p) => (p.block ? bySlide.get(p.block) : undefined)) };
}

/** A look as an AI that designs meets it: its name, its brief, how many pictures it has, and those pictures as small JPEGs, the ones made and liked first. */
interface Look {
  id?: string;
  name: string;
  /** a carousel style is made for the Designer; an animation style is how a video's cards look (a plug-in's collections are those too) */
  kind: "carousel style" | "animation style";
  brief: string;
  pictures: number;
  show: (max: number) => Promise<{ jpeg: string; made: boolean }[]>;
}

/**
 * The looks an AI may design in: the account's own carousel styles, its animation styles, then the ones a plug-in
 * keeps (a studio's own collections). A plug-in's look named like one of the account's own is left out.
 * ponytail: a plug-in's pictures are made small at every read that shows them (a few a call); kept by file and
 * change time when that is felt.
 */
async function looksOf(user: AuthVars["user"], owner: string): Promise<Look[]> {
  const ownOf = (list: AnimationStyle[], kind: Look["kind"]) => list.map((s): Look => ({
    id: s.id,
    name: s.name,
    kind,
    brief: s.brief,
    pictures: s.pictures.length,
    show: async (max) => {
      const p = await stylePictures(owner, s, max);
      return p.images.map((i, n) => ({ jpeg: i.jpegBase64, made: n < p.made }));
    },
  }));
  // the carousel styles of the workspace the request works in; animation styles are the account's
  const keep = await inCurrentWorkspace(user);
  const own = [...ownOf(carouselStyles(owner).filter((s) => !keep || keep(s.projectId)), "carousel style"), ...ownOf(animationStyles(owner), "animation style")];
  const theirs = (await pluginLooks(user)).filter((l) => l.name.trim() && !own.some((o) => o.name.toLowerCase() === l.name.toLowerCase()));
  return [
    ...own,
    ...theirs.map((l): Look => ({
      name: l.name,
      kind: "animation style",
      brief: l.brief,
      pictures: l.pictures.length,
      show: async (max) => {
        const out: { jpeg: string; made: boolean }[] = [];
        for (const p of [...l.pictures.filter((x) => x.made), ...l.pictures.filter((x) => !x.made)]) {
          if (out.length >= max) break;
          const jpeg = await smallJpeg(p.file, LOOK_SIDE, owner);
          if (jpeg) out.push({ jpeg, made: p.made });
        }
        return out;
      },
    })),
  ];
}

/** Where an AI finds pictures to design from when the person's carousel styles give none, in order. */
const toAnalyzer = (animated: string[]) =>
  `Before you design, look at carousels they saved in the Content Analyzer: instagram_search with "kind":"carousel" (with words of this design's subject, or none for the most watched), then instagram_post with "pictures":true for two or three that fit what they asked; carry their finish into the frames, never their words or one of them copied.${animated.length ? ` With none saved, design in one of their animation styles (${animated.slice(0, 12).map((n) => `"${n}"`).join(", ")}: design_get with "look": its name); it was made for a video's cards, so take what a still slide can carry.` : ""} The user keeps carousel styles in the Designer (Carousel styles).`;

/**
 * What an AI is given to design from: each frame with its size, its words and its layers, the fonts, the pictures,
 * the person's looks in their own words, one look's pictures, and how a design is changed. The look whose pictures it
 * gets: the one it asked for by name; unasked, the person's one carousel style when they have exactly one with
 * pictures or words (an AI that never asks still designs from it; one with words alone is sent for pictures too). With several, it is told to pick one and read it first.
 * With none, it is sent to the carousels they saved in the Content Analyzer, and then to an animation style: a look
 * made for a video's cards is what it designed in before carousel styles were there, and better than none.
 */
async function forAi(user: AuthVars["user"], d: Design, lookNamed: string | undefined) {
  const { pages, words } = await framesForAi(user, d);
  const looks = await looksOf(user, d.owner);
  // a carousel style counts with pictures or with words of the person's: its words are read whole
  const carousels = looks.filter((l) => l.kind === "carousel style" && (l.pictures > 0 || l.brief.trim()));
  const animated = looks.filter((l) => l.kind === "animation style" && l.pictures > 0);
  const style = lookNamed ? looks.find((s) => s.id === lookNamed || s.name.toLowerCase() === lookNamed.toLowerCase()) : carousels.length === 1 ? carousels[0] : undefined;
  const shown = style ? await style.show(lookNamed ? LOOK_PICTURES : LOOK_UNASKED) : null;
  return {
    id: d.id,
    name: d.name,
    // the app's own, then the person's own; and the weights of each that has more than one
    ...(await (async () => {
      const fonts = [...DESIGN_FONTS.map((f) => f.family), ...(await fontsOf(d.owner)).map((f) => f.family)];
      const weights = Object.fromEntries(fonts.flatMap((f) => (weightsOf(f, fonts).length > 1 ? [[f, weightsOf(f, fonts)]] : [])));
      return { fonts, weights };
    })()),
    pictures: d.pictures.map((id) => ({ id, what: d.from && "version" in d.from && id === d.pictures[0] ? "the video's own frame" : "a picture added to this design" })),
    // a look is its pictures first: its name and brief are what words carry, and its pictures come when it is asked for
    looks: looks.slice(0, 12).map((s) => ({ name: s.name, kind: s.kind, ...(s.brief.trim() ? { brief: s.brief.trim().slice(0, LOOK_LISTED) } : {}), pictures: s.pictures })),
    ...(lookNamed && !style ? { look: `There is no look called ${lookNamed}` } : {}),
    ...(!lookNamed && carousels.length > 1 ? { look: `Pick the carousel style this design is in (${carousels.slice(0, 12).map((l) => `"${l.name}"`).join(", ")}; ask the user when it is not clear) and read its pictures before you design: design_get with "look": its name.` } : {}),
    ...(!lookNamed && !carousels.length ? { look: `The user has no carousel style yet. ${toAnalyzer(animated.map((l) => l.name))}` } : {}),
    ...(style && shown ? { look: { name: style.name, ...(style.brief.trim() ? { brief: style.brief.trim().slice(0, LOOK_BRIEF) } : {}), pictures: shown.map((i) => ({ what: i.made ? "a picture the user made and liked in this look" : "an inspiration for this look", jpeg: i.jpeg })), ...(shown.length ? {} : { more: `It has no pictures yet. ${toAnalyzer([])}` }) } } : {}),
    // layers lying loose beside the frames are no frame: they are the canvas's, in its own pixels
    frames: pages.flatMap((p, k) => (p.loose ? [] : [{ id: p.id, n: k + 1, ...(p.name ? { name: p.name } : {}), x: p.x, y: p.y, w: p.w, h: p.h, ...(p.clip === false ? { clip: false } : {}), ...(words[k] !== undefined ? { words: words[k] } : {}), background: p.background, ...(p.gradient ? { gradient: p.gradient } : {}), ...(p.fills ? { fills: p.fills } : {}), ...(p.strokes ? { strokes: p.strokes } : {}), ...(p.grain ? { grain: p.grain } : {}), ...(p.vignette ? { vignette: p.vignette } : {}), ...(p.guides ? { guides: p.guides } : {}), ...(p.grids ? { grids: p.grids } : {}), ...(p.safe ? { safe: p.safe } : {}), layers: p.layers }])),
    ...(pages.some((p) => p.loose) ? { canvas: canvasLayers(pages).map((c) => c.layer) } : {}),
    how: HOW,
  };
}

type Raw = Record<string, unknown>;
const raw = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/**
 * An AI's changes onto the design: whole frames (`frames`) and single layers (`changes`). Every frame they touch
 * goes through the same check as anything else that is saved, with its slide's words held. The answer names what
 * was left out and why, each note led by where it was given ("changes[3]", "frames[0].layers[2]") and the frame and
 * layer it is about, and the frames that changed. A new frame or layer may be given a name ("as") that the changes
 * after it use for its frame or layer: `named` says the id each name became, when it is another.
 */
async function writeForAi(user: AuthVars["user"], d: Design, body: Raw): Promise<DesignAnswer & { touched: string[]; wrote: { frame: string; isNew: boolean; layers: string[] }[]; named: Record<string, string> }> {
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
  /** where each layer of this call was given ("changes[2]"), and the last place that touched each frame */
  const givenAt = new Map<unknown, string>();
  const frameAt = new Map<string, string>();
  /** the layers this call adds: a note about one is named by where it was given alone (the id it was to have is no layer's) */
  const added = new Set<unknown>();
  /** a name a new frame or layer was given → its id (a layer's under "<frame id>\0<name>") */
  const named = new Map<string, string>();
  const where = (at: string | undefined, page: DesignPage, layer?: unknown) =>
    [at, `frame ${page.id} (Frame ${next.indexOf(page) + 1})`, typeof layer === "string" && layer ? `layer ${layer}` : ""].filter(Boolean).join(", ");

  // pictures lying loose beside the frames are the person's: no frame of an AI's to write
  const frameIds = () => next.filter((p) => !p.loose).map((p) => p.id);
  for (const [i, f] of frames.slice(0, DESIGN_LIMITS.pages).entries()) {
    const at = `frames[${i}]`;
    if (!f) {
      notes.push(`${at}: not a frame (an object with "id", or "w", "h" and "name" for a new one): left out`);
      continue;
    }
    let page = typeof f.id === "string" ? next.find((p) => p.id === (named.get(f.id as string) ?? f.id) && !p.loose) : undefined;
    if (typeof f.id === "string" && !page) {
      notes.push(`${at}: there is no frame ${f.id}: this design's are ${frameIds().join(", ")} (a new frame has no "id": name it with "as")`);
      continue;
    }
    if (!page) {
      if (frameIds().length >= DESIGN_LIMITS.pages) {
        notes.push(`${at}: a design holds at most ${DESIGN_LIMITS.pages} frames: the new one was not added`);
        continue;
      }
      page = { id: `f${Date.now().toString(36)}${next.length}`, background: "#ffffff", layers: [] };
      if (typeof f.as === "string" && f.as) named.set(f.as, page.id);
      // after the frames, before the loose pictures: its place among frames is its number
      const k = frameIds().length;
      next.splice(k, 0, page);
      words.splice(k, 0, undefined);
      open(page).isNew = true;
    }
    const t = open(page);
    frameAt.set(page.id, at);
    if (Array.isArray(f.layers)) {
      t.layers = f.layers;
      t.gave = f.layers.length > 0;
      t.whole = true;
      f.layers.forEach((l, j) => l && typeof l === "object" && givenAt.set(l, `${at}.layers[${j}]`));
    }
    t.more = { ...t.more, ...f };
    delete t.more.as;
  }

  // the layers lying on the canvas outside every frame, in its pixels (canvasLayers); each goes back into its loose
  // piece, and a piece none of whose layers changed (`dirty`) stays as it is
  const canvas: { home: string; real?: string; layer: Raw; set?: true }[] = canvasLayers(next).map((c) => ({ ...c, layer: c.layer as unknown as Raw }));
  const dirty = new Set<string>();
  let homes = 0;
  const newHome = () => `c${Date.now().toString(36)}${homes++}`;
  const room = () => new Set(canvas.map((x) => x.home)).size < DESIGN_LIMITS.loose;
  const full = `The canvas holds at most ${DESIGN_LIMITS.loose} pieces outside its frames`;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  /** A layer from one place on the canvas to another (a frame's top left corner, or the canvas's 0, 0), where it stays on the canvas; it leaves its group. */
  const rehomed = (l: Raw, from: DesignPage | null, to: DesignPage | null): Raw => ({ ...l, x: num(l.x) + (from?.x ?? 0) - (to?.x ?? 0), y: num(l.y) + (from?.y ?? 0) - (to?.y ?? 0), group: undefined });
  // a field that is itself a set of fields ("adjust", "shadow", "gradient") takes the ones given and keeps the rest; null takes it off whole
  const setOn = (was: Raw, set: unknown): Raw => {
    const s = raw(set);
    if (!s) return was;
    const changed: Raw = { ...was, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, raw(v) && raw(was[k]) ? { ...raw(was[k]), ...raw(v) } : v])), id: was.id };
    // new words for a text with runs and no runs of their own: its runs move with the words, as when they are typed
    if (typeof s.text === "string" && !("runs" in s) && was.type === "text" && typeof was.text === "string" && Array.isArray(was.runs)) changed.runs = retext(was as unknown as TextLayer, s.text).runs;
    return changed;
  };
  /** An id no layer in `list` has: the one asked for, else l1, l2… */
  const freeId = (list: readonly unknown[], asked: unknown) => {
    const ids = new Set(list.map((l) => String(raw(l)?.id)));
    let id = typeof asked === "string" && LAYER_ID.test(asked) && !ids.has(asked) ? asked : "";
    for (let n = list.length + 1; !id; n++) if (!ids.has(`l${n}`)) id = `l${n}`;
    return id;
  };
  /** A layer into a frame, on top (or at the back), under an id of its own there: the layer as it is placed. */
  const into = (page: DesignPage, layer: Raw, back: boolean): Raw => {
    const t = open(page);
    const placed = { ...layer, id: freeId(t.layers, layer.id) };
    t.layers = back ? [placed, ...t.layers] : [...t.layers, placed];
    t.set.push(placed.id);
    return placed;
  };
  /** A layer onto the canvas, a loose piece of its own, on top (or at the back). */
  const ontoCanvas = (layer: Raw, back: boolean): Raw => {
    const entry = { home: newHome(), layer: { ...layer, id: freeId(canvas.map((x) => x.layer), layer.id) }, set: true as const };
    if (back) canvas.unshift(entry);
    else canvas.push(entry);
    dirty.add(entry.home);
    return entry.layer;
  };

  for (const [n, c] of changes.slice(0, 200).entries()) {
    const at = `changes[${n}]`;
    const ref = (v: unknown) => (typeof v === "string" ? (named.get(v) ?? v) : v);
    const onCanvas = c?.frame === "canvas";
    const page = c && !onCanvas ? next.find((p) => p.id === ref(c.frame) && !p.loose) : undefined;
    if (!c || (!onCanvas && !page)) {
      notes.push(`${at}: names no frame of this design (${String(c?.frame)}): its frames are ${frameIds().join(", ")}, and "canvas" holds what lies outside them`);
      continue;
    }
    if (page) frameAt.set(page.id, at);
    const home = page ? page.id : "canvas";
    const here = page ? where(at, page) : `${at}, the canvas`;
    // "to": the layer moves to another frame or onto the canvas
    const dest = c.to === undefined || c.to === null ? null : c.to === "canvas" ? ("canvas" as const) : next.find((p) => p.id === ref(c.to) && !p.loose);
    if (dest === undefined) {
      notes.push(`${here}: "to" names no frame of this design (${String(c.to)}): give a frame's id or "canvas"`);
      continue;
    }
    const back = c.at === "back" || c.order === "back";
    const add = raw(c.add);
    if (add) {
      // a name given to it ("as", or an id that is taken or cannot be one) is what later changes call it
      const name = typeof c.as === "string" && c.as ? c.as : typeof add.id === "string" ? add.id : "";
      const asked = { ...add, id: name || add.id };
      let placed: Raw | null = null;
      if (!onCanvas) placed = into(page!, asked, c.at === "back");
      else if (room()) placed = ontoCanvas(asked, c.at === "back");
      else notes.push(`${here}: ${full}: a layer was not added`);
      if (placed) {
        givenAt.set(placed, at);
        added.add(placed);
        if (name) named.set(`${home}\0${name}`, String(placed.id));
      }
      continue;
    }
    const list = page ? open(page).layers : canvas.map((x) => x.layer);
    // a layer that has that id is the one meant: a name given in this call never stands for another layer
    const lid = typeof c.layer === "string" && !list.some((l) => raw(l)?.id === c.layer) ? (named.get(`${home}\0${c.layer}`) ?? c.layer) : c.layer;
    const k = list.findIndex((l) => raw(l)?.id === lid);
    if (k < 0) {
      notes.push(`${here}: there is no layer ${String(c.layer)}: its layers are ${list.map((l) => String(raw(l)?.id)).join(", ") || "none"}`);
      continue;
    }
    const goes = dest && dest !== page && !(dest === "canvas" && onCanvas) ? dest : null;
    if (goes === "canvas" && !room()) {
      notes.push(`${here}, layer ${String(lid)}: ${full}: it stays where it is`);
      continue;
    }
    if (goes && goes !== "canvas" && open(goes).layers.length >= DESIGN_LIMITS.layers) {
      notes.push(`${here}, layer ${String(lid)}: a frame holds at most ${DESIGN_LIMITS.layers} layers: it stays where it is`);
      continue;
    }
    const own = goes && goes !== "canvas" ? words[next.indexOf(goes)] : undefined;
    const moving = own !== undefined && c.remove !== true ? setOn(raw(list[k])!, c.set) : null;
    if (moving?.type === "text" && typeof moving.text === "string" && !inWords(own!, moving.text)) {
      notes.push(`${here}, layer ${String(lid)}: “${moving.text.replace(/\s+/g, " ").slice(0, 60)}” is not in frame ${(goes as DesignPage).id}'s own words: it stays where it is`);
      continue;
    }
    let layer: Raw;
    let was: (typeof canvas)[number] | undefined;
    if (page) layer = open(page).layers.splice(k, 1)[0] as Raw;
    else {
      was = canvas.splice(k, 1)[0]!;
      dirty.add(was.home);
      layer = was.layer;
    }
    if (c.remove === true) continue;
    // moved: its place on the canvas kept, and "set" then in its new home's pixels; a later change finds it there by the same name
    if (goes) {
      const moved = setOn(rehomed(layer, page ?? null, goes === "canvas" ? null : goes), c.set);
      const placed = goes === "canvas" ? ontoCanvas(moved, back) : into(goes, moved, back);
      givenAt.set(placed, at);
      if (goes !== "canvas") frameAt.set(goes.id, at);
      named.set(`${goes === "canvas" ? "canvas" : goes.id}\0${String(c.layer)}`, String(placed.id));
      continue;
    }
    const changed = setOn(layer, c.set);
    givenAt.set(changed, at);
    if (page) {
      const t = open(page);
      t.set.push(String(lid));
      if (c.order === "front") t.layers.push(changed);
      else if (c.order === "back") t.layers.unshift(changed);
      else t.layers.splice(k, 0, changed);
      continue;
    }
    // on the canvas, to the front or the back is a piece of its own there
    if (c.order === "front" || c.order === "back") givenAt.set(ontoCanvas(changed, back), at);
    else canvas.splice(k, 0, { ...was!, layer: changed, set: true });
  }

  const touched: string[] = [];
  const wrote: { frame: string; isNew: boolean; layers: string[] }[] = [];
  const fonts = await fontsFor(d);
  for (const [id, t] of todo) {
    const k = next.findIndex((p) => p.id === id);
    const was = next[k]!;
    // a note about a layer: where that layer was given in this call (a layer that was there already: none), else the frame's last place
    const say = (_: number, why: string, layer?: unknown) => notes.push(`${where(layer === undefined ? frameAt.get(id) : givenAt.get(layer), was, added.has(layer) ? "" : raw(layer)?.id)}: ${why}`);
    const size = (v: unknown, or: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.min(DESIGN_LIMITS.frameMax, Math.max(DESIGN_LIMITS.frameMin, Math.round(v))) : or);
    const [w, h] = [size(t.more.w, was.w), size(t.more.h, was.h)];
    // a new size without the layers given whole: they follow the frame's edges as their pins say
    if (!t.whole && was.w && was.h && w && h && (w !== was.w || h !== was.h)) t.layers = placeLayers(t.layers.filter(raw) as Placed[], { w: was.w, h: was.h }, { w, h }, "stay");
    const made = cleanPages([{ id, layers: t.layers, w, h, background: t.more.background ?? was.background, gradient: "gradient" in t.more ? t.more.gradient : was.gradient, fills: "fills" in t.more ? t.more.fills : was.fills, strokes: "strokes" in t.more ? t.more.strokes : was.strokes, grain: "grain" in t.more ? t.more.grain : was.grain, vignette: "vignette" in t.more ? t.more.vignette : was.vignette, clip: "clip" in t.more ? t.more.clip : was.clip, ...Object.fromEntries((["guides", "grids", "safe"] as const).map((f) => [f, f in t.more ? t.more[f] : was[f]])), name: t.more.name ?? was.name }], {
      w: d.width,
      h: d.height,
      pictures: d.pictures,
      fonts,
      words: [words[k]],
      say,
    });
    const page = made.pages[0]!;
    // layers were given and none of them could be drawn: the frame is as it was (a new one stays, empty)
    if (t.gave && !page.layers.length && !t.isNew) {
      notes.push(`${where(frameAt.get(id), was)}: nothing given could be drawn, so it is as it was`);
      continue;
    }
    // its place on the canvas and its slide are not the AI's to move
    next[k] = { ...page, ...(was.x !== undefined ? { x: was.x, y: was.y } : {}), ...(was.block ? { block: was.block } : {}) };
    touched.push(id);
    // the layers this wrote: all of a frame given whole, else the ones set and the ones added
    const had = new Set(was.layers.map((l) => l.id));
    wrote.push({ frame: id, isNew: t.isNew, layers: page.layers.filter((l) => t.whole || t.isNew || t.set.includes(l.id) || !had.has(l.id)).map((l) => l.id) });
  }
  // the canvas: each loose piece that changed written again round its layers and checked like a frame; one left empty is gone
  if (dirty.size) {
    const pieces: DesignPage[] = [];
    for (const home of new Set(canvas.map((x) => x.home))) {
      const entries = canvas.filter((x) => x.home === home);
      const kept = next.find((p) => p.id === home);
      if (!dirty.has(home) && kept) {
        pieces.push(kept);
        continue;
      }
      // a size left out is what a layer gets anyway (design-check), so the piece is drawn round it
      const sized = entries.map((e) => ({ ...e.layer, x: num(e.layer.x), y: num(e.layer.y), w: num(e.layer.w) || Math.round(d.width / 2), h: num(e.layer.h) || Math.round(d.height / 4) }));
      const x0 = Math.floor(Math.min(...sized.map((l) => l.x)));
      const y0 = Math.floor(Math.min(...sized.map((l) => l.y)));
      const x1 = Math.ceil(Math.max(...sized.map((l) => l.x + l.w)));
      const y1 = Math.ceil(Math.max(...sized.map((l) => l.y + l.h)));
      // each layer back under its id in its piece (a new one: an id of its own there)
      const used = new Set<string>();
      const layers = sized.map((l, n) => {
        const want = entries[n]!.real ?? String(entries[n]!.layer.id);
        let id = LAYER_ID.test(want) && !used.has(want) ? want : "";
        for (let k = 1; !id || used.has(id); k++) id = `l${k}`;
        used.add(id);
        entries[n]!.real = id;
        const out = { ...l, id, x: l.x - x0, y: l.y - y0 };
        if (givenAt.has(entries[n]!.layer)) givenAt.set(out, givenAt.get(entries[n]!.layer)!);
        return out;
      });
      const say = (_: number, why: string, layer?: unknown) => notes.push(`${[givenAt.get(layer), "the canvas"].filter(Boolean).join(", ")}: ${why}`);
      const made = cleanPages([{ id: home, loose: true, x: x0, y: y0, w: x1 - x0, h: y1 - y0, background: "#ffffff", layers }], { w: d.width, h: d.height, pictures: d.pictures, fonts, words: [undefined], say });
      if (made.pages[0]) pieces.push(made.pages[0]);
      for (const e of entries) if (!made.pages[0]?.layers.some((l) => l.id === e.real)) e.real = undefined;
    }
    next.splice(0, next.length, ...next.filter((p) => !p.loose), ...pieces);
    // the layers this wrote, by the ids the canvas gives them now
    const now = canvasLayers(next);
    const set = canvas.filter((e) => e.set && e.real).map((e) => now.find((x) => x.home === e.home && x.real === e.real)?.layer.id);
    wrote.push({ frame: "canvas", isNew: false, layers: set.filter((id): id is string => !!id) });
  }
  if (!touched.length && !dirty.size) throw new DesignError(`Nothing was changed${notes.length ? `: ${notes.slice(0, 4).join("; ")}` : ""}`);
  // onto the design as it is now on disk: a frame this did not touch is as the person has it, and one they moved
  // meanwhile keeps the place they gave it
  const now = (await read(d.owner, d.id)) ?? d;
  const pages = withFrames(
    next.map((p) => {
      const there = now.pages.find((x) => x.id === p.id);
      // a loose piece this wrote is where this put it
      if (!there || (p.loose && dirty.has(p.id))) return p;
      return touched.includes(p.id) ? { ...p, x: there.x, y: there.y } : there;
    }),
    d.width,
    d.height,
  );
  // the names that became another id: a new frame's, and a layer's that was taken or could not be an id
  const renamed = Object.fromEntries([...named].map(([name, id]) => [name.slice(name.indexOf("\0") + 1), id] as const).filter(([name, id]) => name !== id));
  return { design: await save({ ...now, pages, updatedAt: stamp(now) }), notes, touched, wrote, named: renamed };
}

/** The sizes an AI asks copies in: a format's id ("cover") or {name?, w, h}; anything else is named in a note. */
function sizesOf(v: unknown, notes: string[], at: string): { name: string; w: number; h: number }[] {
  const out: { name: string; w: number; h: number }[] = [];
  for (const [i, s] of (Array.isArray(v) ? v : []).slice(0, DESIGN_LIMITS.pages).entries()) {
    const f = formatOf(s) ?? (typeof s === "string" ? DESIGN_FORMATS.find((x) => x.name.toLowerCase() === s.toLowerCase()) : null);
    const r = raw(s);
    const fits = (n: unknown) => typeof n === "number" && n >= DESIGN_LIMITS.frameMin && n <= DESIGN_LIMITS.frameMax;
    if (f) out.push({ name: f.name, w: f.w, h: f.h });
    else if (r && fits(r.w) && fits(r.h)) out.push({ name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : `${Math.round(r.w as number)} × ${Math.round(r.h as number)}`, w: Math.round(r.w as number), h: Math.round(r.h as number) });
    else notes.push(`${at}[${i}]: a size that is neither a format (${DESIGN_FORMATS.map((x) => x.id).join(", ")}) nor {"w","h"} from ${DESIGN_LIMITS.frameMin} to ${DESIGN_LIMITS.frameMax}: ${JSON.stringify(s).slice(0, 60)}`);
  }
  return out;
}

/**
 * An AI's copies (`sizes`: frames copied into other sizes; `fill`: one frame copied a row of data each, in sizes or its
 * own), made in one save. Each copy goes through the same check as any frame; it draws no slide of its own, so its
 * words are its own. `sizes` lays each size's copies in a row under every frame, each under its own frame; `fill` lays
 * a row's copies to the right of every frame, a size under the other, from the frame's own top.
 */
async function copiesForAi(user: AuthVars["user"], d: Design, body: Raw, named: Record<string, string> = {}): Promise<DesignAnswer & { touched: string[]; wrote: { frame: string; isNew: boolean; layers: string[] }[] }> {
  // a frame named with "as" by the frames and changes of the same call
  const ref = (v: unknown) => (typeof v === "string" && Object.hasOwn(named, v) ? named[v] : v);
  /** where each copy was asked for ("fill.rows[2]"), for its notes */
  const madeAt = new Map<string, string>();
  const notes: string[] = [];
  const { pages } = await framesForAi(user, d);
  const frames = pages.filter((p) => !p.loose);
  const now = (await read(d.owner, d.id)) ?? d;
  const there = now.pages.filter((p) => !p.loose);
  const label = (p: DesignPage) => p.name ?? `Frame ${frames.indexOf(p) + 1}`;
  // shortcut: copies are laid below or right of every frame without looking for free room between frames; fine while designs are a few rows of frames
  const bottom = Math.max(0, ...there.map((p) => (p.y ?? 0) + (p.h ?? d.height)));
  let right = Math.max(0, ...there.map((p) => (p.x ?? 0) + (p.w ?? d.width)));
  const made: DesignPage[] = [];
  let room = DESIGN_LIMITS.pages - there.length;
  // copies under each other are twice as far apart as side by side: each frame's name sits above it
  const below = 2 * DESIGN_GAP;
  const ids = new Set(now.pages.map((p) => p.id));
  const fresh = () => {
    let id = "";
    for (let n = made.length; !id || ids.has(id); n++) id = `c${Date.now().toString(36)}${n}`;
    ids.add(id);
    return id;
  };
  const add = (p: DesignPage) => {
    if (room <= 0) return false;
    room--;
    made.push(p);
    return true;
  };
  let full = false;

  const sizes = raw(body.sizes);
  if (sizes) {
    const asked = Array.isArray(sizes.frames) ? sizes.frames.slice(0, DESIGN_LIMITS.pages).map(String) : null;
    const from = asked ? asked.flatMap((id, i) => frames.find((p) => p.id === ref(id)) ?? (notes.push(`sizes.frames[${i}]: there is no frame ${id}: this design's are ${frames.map((p) => p.id).join(", ")}`), [])) : frames;
    let y = bottom + below;
    for (const size of sizesOf(sizes.to, notes, "sizes.to")) {
      if (full) break;
      for (const p of from)
        if (!full) {
          const id = fresh();
          madeAt.set(id, `sizes.to ${size.name}`);
          full = !add({ ...sizedCopy(p, size, id, `${label(p)} ${size.name}`.slice(0, DESIGN_LIMITS.layerName)), x: p.x, y });
        }
      y += size.h + below;
    }
    if (!from.length || !sizes.to) notes.push('sizes: "sizes" takes "to": the sizes, and "frames": the frames to copy (all without it)');
  }

  const fill = raw(body.fill);
  if (fill) {
    const p = frames.find((x) => x.id === ref(fill.frame));
    const rows = (Array.isArray(fill.rows) ? fill.rows.slice(0, DESIGN_LIMITS.pages).map(raw) : []).filter((r): r is Raw => !!r);
    if (!p) notes.push(`fill.frame: "fill" names no frame of this design (${String(fill.frame)}): its frames are ${frames.map((x) => x.id).join(", ")}`);
    else if (!rows.length) notes.push('fill.rows: "fill" takes "rows": one object a copy');
    else {
      const gap = typeof fill.gap === "number" && fill.gap >= 0 ? Math.min(fill.gap, 2000) : DESIGN_GAP;
      const asked = fill.sizes === undefined ? [{ name: "", w: p.w ?? d.width, h: p.h ?? d.height }] : sizesOf(fill.sizes, notes, "fill.sizes");
      const missing = new Set<string>();
      for (const [n, row] of rows.entries()) {
        if (full) break;
        const { page: filled, missing: none } = fillRow(p, row);
        none.forEach((k) => missing.add(k));
        const name = filled.name && filled.name !== p.name ? filled.name : `${label(p)} ${n + 1}`;
        const x = right + gap;
        let y = p.y ?? 0;
        for (const size of asked) {
          if (full) break;
          const id = fresh();
          madeAt.set(id, `fill.rows[${n}]`);
          full = !add({ ...sizedCopy(filled, size, id, `${name}${size.name ? ` ${size.name}` : ""}`.slice(0, DESIGN_LIMITS.layerName)), x, y });
          y += size.h + 2 * gap;
        }
        right = x + Math.max(...asked.map((s) => s.w));
      }
      if (missing.size) notes.push(`fill.rows: ${label(p)} has no layer named ${[...missing].map((k) => `"${k}"`).join(", ")}: give the layers to fill a "name"`);
    }
  }
  if (full) notes.push(`A design holds at most ${DESIGN_LIMITS.pages} frames: the copies after the first ${made.length} were not made`);
  if (!sizes && !fill) throw new DesignError('Give "sizes" or "fill": design_get says how each is written');

  // each copy checked as any frame is, its notes under its own name
  const fonts = await fontsFor(d);
  const kept: DesignPage[] = [];
  for (const c of made) {
    const out = cleanPages([c], { w: d.width, h: d.height, pictures: d.pictures, fonts });
    notes.push(...out.notes.map((note) => note.replace(/^Page 1:/, `${madeAt.get(c.id)}, frame ${c.id} (${c.name}):`)));
    if (out.pages[0]) kept.push({ ...out.pages[0], id: c.id });
  }
  if (!kept.length) throw new DesignError(`No copy was made${notes.length ? `: ${notes.slice(0, 4).join("; ")}` : ""}`);
  const all = withFrames([...now.pages.filter((p) => !p.loose), ...kept, ...now.pages.filter((p) => p.loose)], d.width, d.height);
  return { design: await save({ ...now, pages: all, updatedAt: stamp(now) }), notes, touched: kept.map((p) => p.id), wrote: kept.map((p) => ({ frame: p.id, isNew: true, layers: p.layers.map((l) => l.id) })) };
}

/* ---- routes ---- */

export const designsApp = new Hono<{ Variables: AuthVars }>();
type C = Context<{ Variables: AuthVars }>;

designsApp.use("*", async (c, next) => (c.get("user").role === "visitor" || !USER.test(c.get("user").username) ? c.json({ error: "Sign in with an account to make designs" }, 403) : next()));

const answer = async (c: C, run: () => Promise<object>) => {
  try {
    return c.json(await run());
  } catch (e) {
    if (e instanceof DesignError) return c.json({ error: e.message, ...e.more }, e.status);
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

// The person's carousel styles, kept as their animation styles are (before the routes of one design, as the fonts).
designsApp.route("/styles", carouselApp);

// The person's own fonts (before the routes of one design: "fonts" is no design's id).
const shown = (list: KeptFont[]): DesignFont[] => list.map((f) => ({ id: f.id, family: f.family }));

designsApp.get("/fonts", (c) => answer(c, async () => ({ fonts: shown(await fontsOf(c.get("user").username)) })));

// A font file added: every face in it becomes a font of the person's (a collection holds a whole family). `notes`
// says in words which faces were not added and why; a file that is no font is refused whole.
designsApp.post("/fonts", (c) =>
  answer(c, async () => {
    const owner = c.get("user").username;
    const b = await body(c);
    if (typeof b.data !== "string" || !b.data) throw new DesignError("Send the font file");
    // its size is known before it is unpacked
    if (b.data.length > Math.ceil(DESIGN_LIMITS.fontBytes / 3) * 4 + 4) throw new DesignError(`A font file can be up to ${DESIGN_LIMITS.fontBytes / 1_000_000} MB`);
    let faces: ReturnType<typeof fontFaces>;
    try {
      faces = fontFaces(Buffer.from(b.data, "base64"));
    } catch (e) {
      if (e instanceof FontError) throw new DesignError(e.message);
      throw e;
    }
    return inTurn(owner, async () => {
      const list = await fontsOf(owner);
      const taken = new Set(DESIGN_FONTS.map((f) => f.family.toLowerCase()));
      const added: KeptFont[] = [];
      const notes: string[] = [];
      for (const face of faces) {
        const key = face.family.toLowerCase();
        if (taken.has(key)) notes.push(`${face.family} is one of the app's own fonts`);
        else if (list.some((f) => f.family.toLowerCase() === key)) notes.push(`${face.family} is among your fonts already`);
        else if (list.length >= DESIGN_LIMITS.fonts) notes.push(`${face.family} was not added: ${DESIGN_LIMITS.fonts} fonts is the most (remove one first)`);
        else {
          const kept: KeptFont = { id: randomBytes(8).toString("hex"), family: face.family, ext: face.ext, at: Date.now() };
          await mkdir(fontsDir(owner), { recursive: true });
          await writeFile(fontFile(owner, kept), face.bytes);
          list.push(kept);
          added.push(kept);
        }
      }
      if (added.length) await keepFonts(owner, list);
      return { added: shown(added), notes, fonts: shown(list) };
    });
  }),
);

designsApp.get("/fonts/:fid", async (c) => {
  const owner = c.get("user").username;
  const f = FONT_ID.test(c.req.param("fid")) ? (await fontsOf(owner)).find((x) => x.id === c.req.param("fid")) : undefined;
  const bytes = f ? await readFile(fontFile(owner, f)).catch(() => null) : null;
  if (!f || !bytes) return c.json({ error: "Not found" }, 404);
  return c.body(new Uint8Array(bytes), 200, { "Content-Type": f.ext === "otf" ? "font/otf" : "font/ttf", "Cache-Control": "private, max-age=31536000, immutable" });
});

// A font taken away. The texts set in it keep its name: they are drawn in the app's fallback face until it is added again.
designsApp.delete("/fonts/:fid", (c) =>
  answer(c, async () => {
    const owner = c.get("user").username;
    return inTurn(owner, async () => {
      const list = await fontsOf(owner);
      const f = list.find((x) => x.id === c.req.param("fid"));
      if (!f) throw new DesignError("Not found", 404);
      const left = list.filter((x) => x !== f);
      await keepFonts(owner, left);
      await rm(fontFile(owner, f), { force: true });
      return { fonts: shown(left) };
    });
  }),
);

designsApp.get("/", (c) =>
  answer(c, async () => {
    const owner = c.get("user").username;
    const names = await readdir(dirOf(owner)).catch(() => [] as string[]);
    const all = (await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => read(owner, n.slice(0, -5))))).filter((d): d is Design => !!d);
    const { session, doc } = c.req.query();
    const out = await listed(
      c.get("user"),
      all.filter((d) => !session || !doc || (pieceOf(d)?.session === session && pieceOf(d)?.doc === doc)).sort((a, b) => b.updatedAt - a.updatedAt),
    );
    // the workspace the window is in keeps its own designs (a piece's by its script's workspace now); one piece's
    // design, asked for by the piece, is found wherever it is
    const keep = session && doc ? null : await inCurrentWorkspace(c.get("user"));
    return keep ? out.filter((d) => keep(d.project)) : out;
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
    } else throw new DesignError("Say what the design is of: a carousel piece (its project as session, and doc), a video's moment (version and t), or blank: true");
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
    const pages = withFrames(cleanPages(b.pages, { w: d.width, h: d.height, pictures: d.pictures, fonts: await fontsFor(d) }).pages, d.width, d.height, was);
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
designsApp.post("/:id/pages", (c) =>
  answer(c, async () => {
    const b = await body(c);
    if (b.sizes === undefined && b.fill === undefined) return writeForAi(c.get("user"), await mine(c), b);
    // copies: after the frames and changes of the same call, so a frame designed in it is copied as it now is
    const first = b.frames !== undefined || b.changes !== undefined ? await writeForAi(c.get("user"), await mine(c), b) : null;
    if (!first) return copiesForAi(c.get("user"), await mine(c), b);
    // the frames and changes are saved already: copies that cannot be made are a note, so the AI does not send them again
    const more = await copiesForAi(c.get("user"), first.design, b, first.named).catch((e: unknown) => {
      if (e instanceof DesignError) return { ...first, notes: [e.message], touched: [], wrote: [] };
      throw e;
    });
    return { ...more, notes: [...first.notes, ...more.notes], touched: [...first.touched, ...more.touched], wrote: [...first.wrote, ...more.wrote], named: first.named };
  }),
);
// what it made, to look at: the frames named in ?frames=<id>,<id> (else the first ones) as small pictures, with the words that do not fit
designsApp.get("/:id/look", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    const { pages } = await framesForAi(c.get("user"), d);
    const asked = (c.req.query("frames") ?? "").split(",").map((id) => pages.findIndex((p) => p.id === id && !p.loose) + 1).filter((n) => n > 0);
    const fonts = Object.fromEntries((await fontsOf(d.owner)).map((f) => [f.family, fontFile(d.owner, f)]));
    return pagePictures(d, pages, [...new Set(asked.length ? asked : pages.flatMap((p, k) => (p.loose ? [] : [k + 1])))].slice(0, LOOK_FRAMES), picturesOf(d.owner, d.id), fonts);
  }),
);

designsApp.post("/:id/pictures", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    if (d.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: remove one first`);
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
      id = await addPicture(d, sent.bytes, PICTURE_EXT[sent.type], b.id);
    }
    // `was`: the window that sent it knows the design is newer only by this picture when it knew `was`
    const was = d.updatedAt;
    const updatedAt = stamp(d);
    await save({ ...d, updatedAt });
    return { id, updatedAt, was };
  }),
);

/** The longest side a cut-out is kept at when it comes back too heavy to keep whole: more than any frame shows. */
const CUT_SIDE = 2560;

/** The picture `pid` of the design as bytes a Mac takes (a WebP goes as a PNG), with `tmp` free for the work. */
async function forMac(d: Design, pid: string, tmp: string): Promise<Buffer> {
  if (!PICTURE.test(pid) || !d.pictures.includes(pid)) throw new DesignError("Not found", 404);
  const dir = picturesOf(d.owner, d.id);
  if (!pid.endsWith(".webp")) return readFile(path.join(dir, pid));
  if (!(await pictureInto(d.owner, { files: { src: path.join(dir, pid) }, out: ["-f", "image2", "-c:v", "png"], ext: "png", to: tmp }))) throw new DesignError("That picture could not be read");
  return readFile(tmp);
}

/** A PNG a Mac made, kept smaller when it is over a picture's cap (a cut-out is often several times its photo's weight). */
async function keepable(png: Buffer, tmp: string, what: string): Promise<Buffer> {
  if (png.length <= DESIGN_LIMITS.pictureBytes) return png;
  const whole = `${tmp}.whole.png`;
  await writeFile(whole, png);
  const made = await pictureInto("", { files: { src: whole }, vf: `scale=w='min(${CUT_SIDE},iw)':h='min(${CUT_SIDE},ih)':force_original_aspect_ratio=decrease`, out: ["-f", "image2", "-c:v", "png"], ext: "png", to: tmp }).finally(() => rm(whole, { force: true }));
  if (!made) throw new DesignError(`${what} could not be made smaller`);
  const out = await readFile(tmp);
  if (out.length > 2 * DESIGN_LIMITS.pictureBytes) throw new DesignError(`${what} is too large to keep in a design`);
  return out;
}

/** What a Mac was asked for, or why not: no Mac of theirs on comes with `code: "no_mac"` and the Mac that is not reachable, so a page can say so and do it on the Mac it is open on. */
const fromMac = async <T>(ask: Promise<T>): Promise<T> => {
  try {
    return await ask;
  } catch (e) {
    if (e instanceof NoMac) throw new DesignError(e.message, 400, { code: "no_mac", ...(e.device ? { device: e.device } : {}) });
    throw new DesignError(e instanceof Error ? e.message : String(e));
  }
};

// A picture of the design with its background taken away, as a new picture of the design (the first one stays: the
// layer that shows the cut-out names it, so the background can be put back). The cutting is done by a Mac of the
// person's own (lib/cutouts.ts): nothing leaves their machines, and without such a Mac the answer says what is missing.
designsApp.post("/:id/pictures/:pid/cutout", (c) =>
  answer(c, async () => {
    const d = await mine(c);
    if (d.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: remove one first`);
    const tmp = path.join(picturesOf(d.owner, d.id), `.cut-${randomBytes(6).toString("hex")}.png`);
    try {
      const cut = await keepable(await fromMac(cutOut(d.owner, await forMac(d, c.req.param("pid"), tmp))), tmp, "The cut-out");
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

/**
 * A picture split into what a design is made of, by a Mac of the person's own (lib/cutouts.ts): what is left behind its
 * words and pieces, and each piece, become pictures of the design; the lines come back as the Mac read them. Which
 * layers they make is the page's to say (src/lib/design/split.ts). The biggest pieces are kept when the design has no
 * room for all of them.
 */
designsApp.post("/:id/pictures/:pid/split", (c) =>
  answer(c, async (): Promise<SplitAnswer> => {
    const d = await mine(c);
    if (d.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: remove one first`);
    const tmp = path.join(picturesOf(d.owner, d.id), `.split-${randomBytes(6).toString("hex")}.png`);
    try {
      const made = await fromMac(splitPicture(d.owner, await forMac(d, c.req.param("pid"), tmp)));
      const now = (await read(d.owner, d.id)) ?? d;
      if (now.pictures.length >= DESIGN_LIMITS.pictures) throw new DesignError(`A design holds up to ${DESIGN_LIMITS.pictures} pictures: remove one first`);
      const background = await addPicture(now, await keepable(made.background, tmp, "The picture behind"), "png");
      const room = DESIGN_LIMITS.pictures - now.pictures.length;
      const biggest = made.layout.pieces.map((b, n) => ({ ...b, n })).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, room).sort((a, b) => a.n - b.n);
      const pieces: SplitAnswer["pieces"] = [];
      for (const { n, ...box } of biggest) pieces.push({ ...box, picture: await addPicture(now, await keepable(made.pieces[n]!, tmp, "A piece"), "png") });
      await save({ ...now, updatedAt: stamp(now) });
      return { background, pieces, lines: made.layout.lines };
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
