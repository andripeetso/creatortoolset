import type { PictureSpec } from "@contracts/design";
import { drawingUrl, drawPage, fontOf, lineHeightOf, setText, sourceOf, textWidth, type Loaded } from "./draw";

/**
 * A page as a small JPEG, drawn by the same function as the designer's canvas and the saved PNG, and the words on it
 * that do not fit their box (measured with the real fonts). An AI that designs the pages is shown this, so it sees
 * what it made and what to fix. Run in the server's drawing browser (render-entry.tsx), never in the app's own page.
 */
export async function pagePicture(spec: PictureSpec): Promise<{ jpeg: string; spills: string[] }> {
  const layers = spec.page.layers.filter((l) => !l.hidden);
  await Promise.all([...new Set(layers.flatMap((l) => (l.type === "text" ? [fontOf(l)] : [])))].map((f) => document.fonts.load(f).catch(() => [])));
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
  const c = document.createElement("canvas");
  c.width = Math.round(spec.width * spec.scale);
  c.height = Math.round(spec.height * spec.scale);
  const ctx = c.getContext("2d")!;
  ctx.setTransform(spec.scale, 0, 0, spec.scale, 0, 0);
  drawPage(ctx, spec.page, spec.width, spec.height, loaded, true);
  const spills: string[] = [];
  for (const l of layers) {
    if (l.type !== "text") continue;
    ctx.font = fontOf(l);
    // as it is drawn: at the size it shrank to, when it shrinks to fit
    const set = setText(l, (t) => ctx.measureText(t).width);
    const drawn = { ...l, size: set.size };
    ctx.font = fontOf(drawn);
    const widthOf = (s: string) => textWidth(l, s, (t) => ctx.measureText(t).width);
    const lines = set.lines;
    const wide = Math.ceil(Math.max(...lines.map(widthOf)));
    const tall = Math.ceil(lines.length * lineHeightOf(drawn));
    const said = `“${l.text.replace(/\s+/g, " ").slice(0, 40)}”`;
    if (wide > l.w + 1 || tall > l.h + 1) spills.push(`${said} does not fit its box: at size ${set.size} it takes ${wide} × ${tall}, and the box is ${l.w} × ${l.h}${l.fit === "shrink" ? " (it cannot shrink further)" : ""}`);
    // words that fit their box and are still cut: the box itself reaches over the frame's edge (a turned box is left to the eye)
    else if (!l.rotate) {
      const left = l.x + (l.align === "center" ? (l.w - wide) / 2 : l.align === "right" ? l.w - wide : 0);
      const top = l.y + (l.valign === "middle" ? (l.h - tall) / 2 : l.valign === "bottom" ? l.h - tall : 0);
      if (left < -1 || top < -1 || left + wide > spec.width + 1 || top + tall > spec.height + 1) spills.push(`${said} is cut off at the frame's edge: the words run from ${Math.round(left)}, ${Math.round(top)} to ${Math.round(left + wide)}, ${Math.round(top + tall)}, and the frame is ${spec.width} × ${spec.height}`);
    }
  }
  return { jpeg: c.toDataURL("image/jpeg", 0.82).split(",")[1] ?? "", spills };
}
