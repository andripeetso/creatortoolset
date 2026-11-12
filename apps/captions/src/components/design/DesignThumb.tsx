import { useEffect, useRef, useState } from "react";
import type { Design } from "@contracts/design";
import { drawingUrl, drawPage, fontOf, sourceOf, type Loaded } from "@/lib/design/draw";
import { getDesign, pictureUrl } from "@/lib/designs";

/**
 * A design's first page, small, drawn by the same function as the designer's canvas. `stamp` is the design's last
 * change: a new one reads and draws it again.
 * ponytail: each card reads its whole design; a saved picture of the first page when lists get long.
 */
export function DesignThumb({ id, stamp, width, height }: { id: string; stamp: number; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [design, setDesign] = useState<Design | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [loaded] = useState<Loaded>(() => new Map());

  useEffect(() => {
    let gone = false;
    getDesign(id).then((d) => !gone && setDesign(d), () => {});
    return () => void (gone = true);
  }, [id, stamp]);

  useEffect(() => {
    const page = design?.pages[0];
    if (!design || !page) return;
    const again = () => setDrawn((n) => n + 1);
    for (const l of page.layers) {
      const src = sourceOf(l);
      if (src && !loaded.has(src)) {
        const img = new Image();
        loaded.set(src, img);
        img.onload = again;
        img.src = l.type === "image" ? pictureUrl(design.id, src) : drawingUrl(src);
      }
      if (l.type === "text") void document.fonts.load(fontOf(l)).then(again, () => {});
    }
  }, [design, loaded]);

  useEffect(() => {
    const c = canvas.current;
    const page = design?.pages[0];
    if (!c || !design || !page) return;
    // drawn at twice the card's size at most: sharp on a dense screen, small in memory
    const k = Math.min(1, 640 / design.width);
    c.width = Math.round(design.width * k);
    c.height = Math.round(design.height * k);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawPage(ctx, page, design.width, design.height, loaded);
  }, [design, drawn, loaded]);

  return <canvas ref={canvas} aria-hidden className="block w-full bg-zinc-500/10" style={{ aspectRatio: `${width} / ${height}` }} />;
}
