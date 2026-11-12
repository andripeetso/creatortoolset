/**
 * Designs: pictures the person's AI designs and the person then changes by hand. A carousel's slides (from a Content
 * Workshop carousel piece), a video's cover, a thumbnail. A design is pages of layers: text, pictures, shapes and
 * drawings, each with a place and a size in the picture's own pixels. It is data, never a program: the AI answers
 * layers, code checks every value (api/designs.ts), the browser draws them (src/lib/design/draw.ts) and saves each
 * page as a PNG of exactly the design's size.
 *
 * Contract (api/designs.ts, mounted at /api/designs):
 *   GET    /api/designs?session=&doc=   → DesignSummary[] (mine; narrowed to one Workshop piece when both are given)
 *   POST   /api/designs                 NewDesign → Design
 *   GET    /api/designs/:id             → Design
 *   PUT    /api/designs/:id             { name?, pages?, look? } → Design (what the person changed by hand)
 *   DELETE /api/designs/:id
 *   POST   /api/designs/:id/design      { look?: string | null, notes?: string } → DesignAnswer (the AI designs the pages)
 *   GET    /api/designs/:id/pages       → what an AI designs from: the size, fonts, pictures, looks' briefs, each page with its words, how layers are written
 *   POST   /api/designs/:id/pages       { pages: [{ page, background?, layers }] } → DesignAnswer (an AI's pages: each one named is replaced, checked as above)
 *   POST   /api/designs/:id/pictures    { name, type, data (base64) } → { id }   (JPEG, PNG or WebP)
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

export const DESIGN_LIMITS = { pages: 20, layers: 40, text: 600, svg: 20_000, name: 120, layerName: 60, notes: 2000, pictures: 60, pictureBytes: 8_000_000 } as const;

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
  /** one of the app's font families (src/lib/types.ts FONT_OPTIONS) */
  font: string;
  /** letter height in pixels */
  size: number;
  /** "#rrggbb" */
  color: string;
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
  /** corner radius in pixels */
  radius?: number;
}

export interface ShapeLayer extends Box {
  type: "shape";
  shape: "rect" | "ellipse";
  fill: string;
  radius?: number;
  stroke?: { color: string; width: number };
}

/** A drawing the AI made: SVG markup with a viewBox and no text, no script, no link and nothing from outside it. */
export interface DrawingLayer extends Box {
  type: "drawing";
  svg: string;
}

export type Layer = TextLayer | ImageLayer | ShapeLayer | DrawingLayer;

export interface DesignPage {
  id: string;
  /** what the canvas and the layers list call it; absent = "Page 3" by its place */
  name?: string;
  /** "#rrggbb" */
  background: string;
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
export type NewDesign = { format: DesignFormat; name?: string } & ({ session: string; doc: string } | { version: string; t: number; title?: string });

/** The AI's design, checked: the design as saved, and what was left out of the answer and why. */
export interface DesignAnswer {
  design: Design;
  notes: string[];
}
