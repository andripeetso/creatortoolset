import type { DesignPage, Gradient, GradientStop, Layer, Paint, PaintLook, Stroke } from "../../../contracts/design";

/**
 * A layer's or a frame's fills and lines as lists (contracts/design.ts `fills`, `strokes`, bottom first). A design
 * saved before there were lists has one fill (`fill`/`color`/`background` and its `gradient`) and one line (`stroke`,
 * a text's `outline`): those are read as a list of one, so an old design is drawn as it was. Writing a list back
 * keeps the old fields when the list says no more than they can (one plain colour, one plain line), so a window or an
 * AI that knows only them still reads it right. No DOM here: the server's check reads it too.
 */

type Painted = Layer | DesignPage;
const isPage = (o: Painted): o is DesignPage => !("type" in o);

/** An old gradient (from the layer's own colour to `to`, maybe through `via` half-way) as a gradient paint. */
export const gradientPaint = (from: string, g: Gradient): Paint => ({
  type: "gradient",
  ...(g.kind ? { kind: g.kind } : {}),
  angle: g.angle,
  stops: [{ at: 0, color: from }, ...(g.via ? [{ at: 0.5, color: g.via }] : []), { at: 1, color: g.to }],
});
const oldFill = (color: string, g: Gradient | undefined): Paint => (g ? gradientPaint(color, g) : { type: "solid", color });

/** What can have fills: a frame, a text, a shape, a path. */
export const takesFills = (o: Painted): boolean => isPage(o) || o.type === "text" || o.type === "shape" || o.type === "path";
/** What can have lines: those and a picture. */
export const takesStrokes = (o: Painted): boolean => takesFills(o) || (!isPage(o) && o.type === "image");

export function fillsOf(o: Painted): Paint[] {
  if (isPage(o)) return o.fills ?? [oldFill(o.background, o.gradient)];
  if (o.type === "text") return o.fills ?? [oldFill(o.color, o.gradient)];
  if (o.type === "shape") return o.fills ?? [oldFill(o.fill, o.gradient)];
  if (o.type === "path") return o.fills ?? (o.fill ? [oldFill(o.fill, o.gradient)] : []);
  return [];
}

export function strokesOf(o: Painted): Stroke[] {
  if (isPage(o)) return o.strokes ?? [];
  if (o.type === "text") return o.strokes ?? (o.outline ? [{ ...o.outline }] : []);
  if (o.type === "shape" || o.type === "path") return o.strokes ?? (o.stroke ? [o.stroke] : []);
  if (o.type === "image") return o.strokes ?? [];
  return [];
}

const plain = (p: PaintLook) => !p.hidden && p.opacity === undefined && !p.blend;
/** The first plain colour of a list, bottom first: what the old field keeps for whatever reads only it (the box words are typed in). */
const firstColour = (fills: readonly Paint[]) => fills.find((p): p is Extract<Paint, { type: "solid" }> => p.type === "solid")?.color;

/** `o` with these fills: one plain colour as the old field alone, anything else as `fills` (the old gradient goes). */
export function withFills<T extends Painted>(o: T, fills: Paint[]): T {
  const one = fills.length === 1 && fills[0]!.type === "solid" && plain(fills[0]!) ? fills[0]!.color : null;
  const { fills: _f, gradient: _g, ...rest } = o as Painted & { fills?: Paint[]; gradient?: Gradient };
  const colour = one ?? firstColour(fills);
  const list = one ? {} : { fills };
  if (isPage(o)) return { ...rest, ...(colour ? { background: colour } : {}), ...list } as T;
  if (o.type === "text") return { ...rest, ...(colour ? { color: colour } : {}), ...list } as T;
  if (o.type === "shape") return { ...rest, ...(colour ? { fill: colour } : {}), ...list } as T;
  if (o.type === "path") {
    // a path without a fill is a line alone: no old `fill` left to say otherwise
    const { fill: _p, ...line } = rest as Omit<Extract<Layer, { type: "path" }>, "fills" | "gradient">;
    return { ...line, ...(colour ? { fill: colour } : {}), ...(one || !fills.length ? {} : { fills }) } as T;
  }
  return o;
}

/** A line the old `stroke` can say whole (a text's `outline`: a colour and a width alone). */
const oldLine = (s: Stroke) => plain(s) && !s.sides && !s.cap && !s.join && !s.start && !s.end;

/** `o` with these lines: one plain line as the old field alone, anything else as `strokes`. */
export function withStrokes<T extends Painted>(o: T, strokes: Stroke[]): T {
  const one = strokes.length === 1 && oldLine(strokes[0]!) ? strokes[0]! : null;
  const { strokes: _s, ...rest } = o as Painted & { strokes?: Stroke[] };
  const list = strokes.length ? { strokes } : {};
  if (isPage(o) || o.type === "image") return { ...rest, ...list } as T;
  if (o.type === "text") {
    const { outline: _o, ...r } = rest as Omit<Extract<Layer, { type: "text" }>, "strokes">;
    return { ...r, ...(one && !one.dash && !one.round && !one.side ? { outline: { color: one.color, width: one.width } } : list) } as T;
  }
  if (o.type === "shape" || o.type === "path") {
    const { stroke: _o, ...r } = rest as Omit<Extract<Layer, { type: "shape" }>, "strokes">;
    return { ...r, ...(one ? { stroke: one } : list) } as T;
  }
  return o;
}

/** A list with the item at `from` moved to `to` (both places in the list as it was). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" as red, green, blue (0 to 255) and how solid it is (0 to 1); black when it is none of them. */
export function rgba(hex: string): [number, number, number, number] {
  let d = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())?.[1] ?? "000";
  if (d.length < 6) d = d.replace(/./g, "$&$&");
  const n = (k: number) => parseInt(d.slice(k, k + 2), 16);
  return [n(0), n(2), n(4), d.length === 8 ? n(6) / 255 : 1];
}

/** Red, green, blue and how solid as "#rrggbb", or "#rrggbbaa" when it is not wholly solid. */
export function hexOf(r: number, g: number, b: number, a = 1): string {
  const two = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}${a < 1 ? two(a * 255) : ""}`;
}

/** The colour a gradient has at `at` (0 to 1): between the two stops round it, in proportion. */
export function colourAt(stops: readonly GradientStop[], at: number): string {
  const s = [...stops].sort((a, b) => a.at - b.at);
  if (!s.length) return "#000000";
  const after = s.findIndex((x) => x.at >= at);
  if (after <= 0) return s[after < 0 ? s.length - 1 : 0]!.color;
  const a = s[after - 1]!;
  const b = s[after]!;
  const t = b.at === a.at ? 0 : (at - a.at) / (b.at - a.at);
  const [p, q] = [rgba(a.color), rgba(b.color)];
  return hexOf(...(p.map((v, k) => v + (q[k]! - v) * t) as [number, number, number, number]));
}

/** The pictures a frame's fills and its layers' fills show (an image layer's own picture is its `picture`, not here). */
export const paintPictures = (page: DesignPage): string[] => [
  ...new Set(
    [page, ...page.layers.filter((l) => !l.hidden)].flatMap((o) => (takesFills(o) ? fillsOf(o) : []).flatMap((p) => (p.type === "image" && !p.hidden ? [p.picture] : []))),
  ),
];
