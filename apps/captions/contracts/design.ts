/**
 * Designs: pictures the person's AI designs and the person then changes by hand. A carousel's slides (from a Content
 * Workshop carousel piece), a video's cover, a thumbnail. A design is one canvas of frames, each a picture of its own
 * size made of layers: text, pictures, shapes and drawings, each with a place and a size in its frame's own pixels.
 * It is data, never a program: the AI answers layers, code checks every value (api/designs.ts), the browser draws
 * them (src/lib/design/draw.ts) and saves each frame as a PNG of exactly its size.
 *
 * Contract (api/designs.ts, mounted at /api/designs):
 *   GET    /api/designs?session=&doc=   → DesignSummary[] (mine; narrowed to one Workshop piece when both are given)
 *   POST   /api/designs                 NewDesign → Design (a piece's slides, a video's frame, or blank pages)
 *   GET    /api/designs/:id             → Design
 *   PUT    /api/designs/:id             { name?, pages?, since? } → Design (what the person changed by hand). `since`: the updatedAt this window last knew; the design changed after it → 409 { error, design } and nothing is written
 *   DELETE /api/designs/:id
 *   GET    /api/designs/:id/pages       ?look=<name> → what an AI designs from: the fonts, pictures, looks' briefs (one look's pictures when named), each frame with its id, size, words and layers, and how frames and changes are written
 *   POST   /api/designs/:id/pages       { frames?: [{ id?, name?, x?, y?, w?, h?, background?, layers }], changes?: [{ frame, layer?, set? | remove? | order? | add? }] } → DesignAnswer & { touched: frame ids } (an AI's work: whole frames replaced or added, or single layers changed; checked as above)
 *   GET    /api/designs/:id/look        ?frames=<id>,<id> → { pictures: [{ page, jpeg (base64), spills }], why? }: the frames as small pictures, for the AI to look at
 *   POST   /api/designs/:id/pictures    { name, type, data (base64) } → { id }   (JPEG, PNG or WebP); or { version, t }: that moment of a library video, copied in
 *   POST   /api/designs/:id/pictures/:pid/cutout   → { id }: that picture with its background taken away, as a new picture of the design (cut by a Mac of the person's own)
 *   GET    /api/designs/:id/pictures/:pid
 * A picture layer names a picture in the design's own folder by its id, never an address: a video's frame and anything
 * else from the library is copied in, so a design keeps what it shows.
 */

/** The picture sizes a design can have, in pixels. `kind` is what it is for. */
export const DESIGN_FORMATS = [
  { id: "portrait", kind: "carousel", name: "Portrait 4:5", w: 1080, h: 1350 },
  { id: "tall", kind: "carousel", name: "Tall 3:4", w: 1080, h: 1440 },
  { id: "square", kind: "carousel", name: "Square 1:1", w: 1080, h: 1080 },
  { id: "cover", kind: "cover", name: "Vertical cover 9:16", w: 1080, h: 1920 },
  { id: "thumbnail", kind: "thumbnail", name: "Wide thumbnail 16:9", w: 1280, h: 720 },
] as const;
export type DesignFormat = (typeof DESIGN_FORMATS)[number]["id"];
export type DesignKind = (typeof DESIGN_FORMATS)[number]["kind"];
export const formatOf = (id: unknown) => DESIGN_FORMATS.find((f) => f.id === id) ?? null;

/** Pixels between two frames the app places itself (a new design's frames in a row, a new frame beside the last). */
export const DESIGN_GAP = 120;

/** What a picture layer can change about its picture's colours, each from -100 to 100 (absent = 0). */
export const DESIGN_ADJUST = ["exposure", "contrast", "highlights", "shadows", "warmth", "tint", "saturation"] as const;
export type DesignAdjust = (typeof DESIGN_ADJUST)[number];

export const DESIGN_LIMITS = { designs: 300, pages: 20, frameMin: 16, frameMax: 4096, canvas: 100_000, layers: 40, text: 2000, svg: 20_000, name: 120, layerName: 60, notes: 2000, pictures: 60, pictureBytes: 8_000_000 } as const;

/** The ways a layer can mix with what is under it, beside lying over it. */
export const DESIGN_BLENDS = ["multiply", "screen", "overlay", "darken", "lighten", "soft-light"] as const;
export type DesignBlend = (typeof DESIGN_BLENDS)[number];
/** The shapes. A triangle points up and an arrow to the right: `rotate` turns them. */
export const DESIGN_SHAPES = ["rect", "ellipse", "triangle", "star", "arrow"] as const;
export type DesignShape = (typeof DESIGN_SHAPES)[number];
/** A fill that runs from the layer's (or frame's) own colour to `to`, along `angle` in degrees: 0 is left to right, 90 top to bottom. */
export interface Gradient {
  to: string;
  angle: number;
}

/** A layer's place: its top left corner and size in the design's pixels; `rotate` in degrees about its middle. */
interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  /** 0 to 1; absent = 1 */
  opacity?: number;
  /** a soft shadow under the layer: its colour ("#rrggbb"), how strong (0 to 1), its blur and how far it falls, in pixels */
  shadow?: { color: string; opacity: number; blur: number; x: number; y: number };
  /** how it mixes with what is under it; absent = it lies over it */
  blend?: DesignBlend;
  /** mirrored left to right, top to bottom */
  flipX?: boolean;
  flipY?: boolean;
  /** layers of a frame with the same group are picked and moved as one (a badge and its words) */
  group?: string;
  /** what the layers list calls it; absent = what it is (a text's own words, "Rectangle", "Picture", "Drawing") */
  name?: string;
  /** kept in the design, but not drawn and not in the saved PNG */
  hidden?: boolean;
  /** drawn, but a press on the page goes through it: it is picked in the layers list only */
  locked?: boolean;
}

export interface TextLayer extends Box {
  type: "text";
  text: string;
  /** one of the designer's font families (src/lib/design/fonts.ts DESIGN_FONTS) */
  font: string;
  /** font size in pixels */
  size: number;
  /** "#rrggbb" */
  color: string;
  gradient?: Gradient;
  /** pixels between the letters, beside the font's own; absent = 0 */
  spacing?: number;
  /** "shrink": `size` is the most, and the words are set at the largest size up to it at which they fit the box */
  fit?: "shrink";
  /** its lines evened out: broken so they are about as long as each other, in no more lines than it takes anyway */
  balance?: boolean;
  align: "left" | "center" | "right";
  /** where the lines sit in the box; absent = top */
  valign?: "top" | "middle" | "bottom";
  /** line height as a multiple of the size; absent = 1.15 */
  lineHeight?: number;
  upper?: boolean;
  /** a line round each letter (sticker letters): its colour and its width in pixels */
  outline?: { color: string; width: number };
}

export interface ImageLayer extends Box {
  type: "image";
  /** the picture's id in this design's folder */
  picture: string;
  /** cover: fills the box and is cut at its edges; contain: fits inside it whole */
  fit: "cover" | "contain";
  /** how much bigger than it fits (1 to 8); absent = 1 */
  zoom?: number;
  /** which part of the picture stays in the box when it is cut: 0 = its left (top) edge, 1 = its right (bottom); absent = the middle */
  focus?: { x: number; y: number };
  /** changes to the picture's colours, each -100 to 100 */
  adjust?: Partial<Record<DesignAdjust, number>>;
  /** two colours in place of the picture's own: its darks become `dark`, its lights `light` (black and white for a black and white picture) */
  duotone?: { dark: string; light: string };
  /** darker (above 0) or lighter (below 0) towards the corners of the box: -100 to 100 */
  vignette?: number;
  /** film grain, 0 to 100 */
  grain?: number;
  /** a soft blur, in the design's pixels */
  blur?: number;
  /** the picture this one was cut out of (its background taken away): kept, so the background can be put back */
  uncut?: string;
  /** corner radius in pixels */
  radius?: number;
}

export interface ShapeLayer extends Box {
  type: "shape";
  shape: DesignShape;
  fill: string;
  gradient?: Gradient;
  radius?: number;
  stroke?: { color: string; width: number };
}

/** A drawing the AI made: SVG markup with a viewBox and no text, no script, no link and nothing from outside it. */
export interface DrawingLayer extends Box {
  type: "drawing";
  svg: string;
}

export type Layer = TextLayer | ImageLayer | ShapeLayer | DrawingLayer;

/**
 * A frame: one picture of the design, with a place and a size of its own on the design's canvas, so a carousel's
 * slides, a cover and a thumbnail can lie side by side in one design. (Called a page where it is a carousel's.)
 */
export interface DesignPage {
  id: string;
  /** what the canvas and the layers list call it; absent = "Frame 3" by its place in the list */
  name?: string;
  /** its top left corner on the canvas and its size, in pixels. The server gives every frame these (a design saved before frames had a place gets them in a row, each the design's size) */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** the Workshop carousel slide (its block's id) this frame draws: its words are that slide's, as the piece has them now */
  block?: string;
  /** "#rrggbb" */
  background: string;
  gradient?: Gradient;
  /** bottom first: a later layer is drawn over an earlier one */
  layers: Layer[];
}

/** What a design was made from: a Workshop carousel piece (its slides are the pages' words) or a moment of a video. */
export type DesignSource = { session: string; doc: string } | { version: string; t: number };

export interface DesignSummary {
  id: string;
  name: string;
  kind: DesignKind;
  format: DesignFormat;
  width: number;
  height: number;
  pages: number;
  from?: DesignSource;
  updatedAt: number;
}

export interface Design extends Omit<DesignSummary, "pages"> {
  owner: string;
  pages: DesignPage[];
  /** the ids of the pictures in its folder */
  pictures: string[];
  /** the animation style whose brief and pictures the AI last designed it from (contracts/editor-styles.ts) */
  look?: string;
  createdAt: number;
}

/**
 * A new design. From a carousel piece: `session` and `doc`, one page a slide, laid out plainly until the AI designs it.
 * From a video: `version` (a library version) and `t` (seconds): that frame is copied in as the picture, with `title`
 * as its words. `format` must be one of that kind's (a piece: a carousel format; a video: cover or thumbnail).
 */
export type NewDesign = { format: DesignFormat; name?: string } & ({ session: string; doc: string } | { version: string; t: number; title?: string } | { blank: true; pages?: number });

/** What the server's drawing browser is given to draw one page as a small picture (api/lib/design-picture.ts, src/lib/design/picture.ts). */
export interface PictureSpec {
  width: number;
  height: number;
  page: DesignPage;
  /** each picture the page shows, by its id, as a data address (the server made each small first) */
  pictures: Record<string, string>;
  /** picture pixels a design pixel */
  scale: number;
}

/** The AI's design, checked: the design as saved, and what was left out of the answer and why. */
export interface DesignAnswer {
  design: Design;
  notes: string[];
}
