import { PICTURE_SIDE_MAX, type PictureSpec } from "@contracts/design";
import { drawingUrl, drawPage, fontsOfText, sourceOf, textBlock, type Loaded } from "./draw";
import { setOwnFamilies } from "./fonts";
import { paintPictures } from "./paint";

/**
 * A page as a JPEG (small, for an AI that designs the pages: it sees what it made and what to fix), or with `png` as a
 * PNG that keeps what is see-through (a title over a video, at the video's size times its zoom), drawn by the same
 * function as the designer's canvas and the saved PNG, and the words on it that do not fit their box (measured with the
 * real fonts). Hidden and reference layers are left out. Run in the server's drawing browser (render-entry.tsx), or in
 * the app's own page for a picture of its own.
 */
export async function pagePicture(spec: PictureSpec): Promise<{ jpeg?: string; png?: string; spills: string[]; drawn: string[] }> {
  if (!(spec.scale > 0) || Math.round(spec.width * spec.scale) > PICTURE_SIDE_MAX || Math.round(spec.height * spec.scale) > PICTURE_SIDE_MAX) throw new Error(`A page's picture is at most ${PICTURE_SIDE_MAX} pixels a side`);
  const layers = spec.page.layers.filter((l) => !l.hidden && !l.reference);
  // the person's own fonts first: each from its file, once (one that cannot be read is drawn in the fallback face)
  await Promise.all(
    Object.entries(spec.fonts ?? {}).map(async ([family, address]) => {
      if ([...document.fonts].some((f) => f.family.replace(/^"|"$/g, "") === family)) return;
      const face = new FontFace(family, `url("${address}")`, { weight: "400" });
      await face.load().then(() => void document.fonts.add(face), () => {});
    }),
  );
  // a text's weights and slants are faces of its family: the person's own faces of it among them
  setOwnFamilies(Object.keys(spec.fonts ?? {}));
  await Promise.all([...new Set(layers.flatMap((l) => (l.type === "text" ? fontsOfText(l) : [])))].map((f) => document.fonts.load(f).catch(() => [])));
  const loaded: Loaded = new Map();
  await Promise.all(
    layers.map(async (l) => {
      const src = sourceOf(l);
      const address = l.type === "image" ? spec.pictures[l.picture] : l.type === "drawing" ? drawingUrl(l.svg) : undefined;
      if (!src || !address || loaded.has(src)) return;
      const img = new Image();
      img.src = address;
      // one that cannot be read is drawn as its grey place, as on the canvas
      await img.decode().then(() => loaded.set(src, img), () => {});
    }),
  );
  // the pictures that fill shapes, words and the frame
  await Promise.all(
    paintPictures(spec.page).map(async (src) => {
      const address = spec.pictures[src];
      if (!address || loaded.has(src)) return;
      const img = new Image();
      img.src = address;
      await img.decode().then(() => loaded.set(src, img), () => {});
    }),
  );
  const c = document.createElement("canvas");
  c.width = Math.round(spec.width * spec.scale);
  c.height = Math.round(spec.height * spec.scale);
  const ctx = c.getContext("2d")!;
  // a JPEG has nothing see-through: a see-through frame is white there, never black
  if (!spec.png) (ctx.fillStyle = "#ffffff"), ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(spec.scale, 0, 0, spec.scale, 0, 0);
  drawPage(ctx, spec.page, spec.width, spec.height, loaded, true);
  const spills: string[] = [];
  // what the drawing worked out for a text that shrinks: the size it came to and its lines, beside the size it was given
  const worked: string[] = [];
  for (const l of layers) {
    if (l.type !== "text") continue;
    // as it is drawn: at the size it shrank to, when it shrinks to fit
    const set = textBlock(ctx, l);
    const wide = Math.ceil(Math.max(...set.widths));
    const tall = Math.ceil(set.tall);
    const lines = set.widths.length;
    const said = `layer ${l.id} “${l.text.replace(/\s+/g, " ").slice(0, 40)}”`;
    if ((l.fit === "shrink" || l.lines) && set.size < l.size) worked.push(`${said} is drawn at size ${set.size} (its size ${l.size} is the most) in ${lines} ${lines === 1 ? "line" : "lines"}`);
    // a text that shrinks is set by widths measured at one size and scaled, so at the size it lands on it can be drawn up to
    // about 1 % wider than measured: that is no spill (a 2-line headline set at 125.5 drew 907 wide in a 900 box)
    const slack = l.fit === "shrink" || l.lines ? 1.01 : 1;
    if (wide > l.w * slack + 1 || tall > l.h * slack + 1) spills.push(`${said} does not fit its box: at size ${set.size} it takes ${wide} × ${tall}, and the box is ${l.w} × ${l.h}${l.fit === "shrink" || l.lines ? " (it cannot shrink further)" : ""}`);
    // words that fit their box and are still cut: the box itself reaches over the frame's edge (a turned box is left to the eye)
    else if (!l.rotate) {
      const left = l.x + (l.align === "center" ? (l.w - wide) / 2 : l.align === "right" ? l.w - wide : 0);
      const top = l.y + (l.valign === "middle" ? (l.h - tall) / 2 : l.valign === "bottom" ? l.h - tall : 0);
      if (left < -1 || top < -1 || left + wide > spec.width + 1 || top + tall > spec.height + 1) spills.push(`${said} is cut off at the frame's edge: the words run from ${Math.round(left)}, ${Math.round(top)} to ${Math.round(left + wide)}, ${Math.round(top + tall)}, and the frame is ${spec.width} × ${spec.height}`);
    }
  }
  const data = (type: string) => c.toDataURL(type, 0.82).split(",")[1] ?? "";
  return { ...(spec.png ? { png: data("image/png") } : { jpeg: data("image/jpeg") }), spills, drawn: worked };
}
