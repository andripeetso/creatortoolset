import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { localThumb } from "@/lib/local-thumbs";
import { cn } from "@/lib/utils";

/**
 * Long clip lists draw only what is near the screen (as Photos does): each clip's place stays in the layout, its
 * contents only while within MARGIN of view. A thousand clips then cost about what one screen of them does.
 */
const MARGIN = 1.5; // screens above and below
const ROOT_MARGIN = `${MARGIN * 100}% 0px`;

const onChange = new Map<Element, (near: boolean) => void>();
let watcher: IntersectionObserver | null = null;
/** One observer for every place on the page, not one per clip. */
function watch(el: Element, set: (near: boolean) => void): () => void {
  watcher ??= new IntersectionObserver((seen) => seen.forEach((s) => onChange.get(s.target)?.(s.isIntersecting)), { rootMargin: ROOT_MARGIN });
  onChange.set(el, set);
  watcher.observe(el);
  return () => {
    onChange.delete(el);
    watcher?.unobserve(el);
  };
}

/** Whether `top..bottom` (a box's place on screen) is within MARGIN screens of view. */
export const nearView = (top: number, bottom: number, screen: number) => bottom >= -MARGIN * screen && top <= screen * (1 + MARGIN);

/** The height a place of each `same` key had when last drawn: a place not drawn yet stands in at it. */
const typical = new Map<string, number>();

/**
 * One clip's place in a long list. `children` is called only while it is near; elsewhere the place is an empty box of
 * the height it had when last drawn, so nothing around it moves. Never drawn yet: of `size` (its shape: a known aspect
 * ratio), or, with `same`, of the height the last drawn place of that key had (cards and rows of one list are one height). Without IntersectionObserver everything is drawn.
 */
export function Near({ children, className, size, same }: { children: () => ReactNode; className?: string; size?: CSSProperties; same?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const own = useRef<number | undefined>(undefined); // its own height when last drawn: off screen it keeps exactly that
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  // before the first paint: drawn at once when on screen, so opening a folder never shows empty boxes
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && nearView(r.top, r.bottom, window.innerHeight)) setNear(true);
  }, []);
  useEffect(() => (ref.current && typeof IntersectionObserver !== "undefined" ? watch(ref.current, setNear) : undefined), []);
  useEffect(() => {
    if (!near || !ref.current?.offsetHeight) return;
    own.current = ref.current.offsetHeight;
    if (same) typical.set(same, own.current);
  });
  const known = same ? typical.get(same) : undefined;
  return (
    <div ref={ref} className={className} style={near ? undefined : own.current || known ? { height: own.current ?? known } : (size ?? { height: 160 })}>
      {near ? children() : null}
    </div>
  );
}

/**
 * A clip's picture: from this Mac's own copy when the Mac app keeps one (lib/local-thumbs.ts), decoded off the main
 * thread, and faded in once it is here rather than drawn in pieces. `dim`: a clip whose file is missing.
 */
export function ThumbImg({ src, className, style, dim }: { src: string; className?: string; style?: CSSProperties; dim?: boolean }) {
  const shown = (el: HTMLImageElement | null) => el && (el.dataset.in = "");
  return (
    <img
      src={localThumb(src)}
      alt=""
      decoding="async"
      // a picture already decoded (the browser's or this Mac's copy) is shown at once, with no fade
      ref={(el) => void (el?.complete && el.naturalWidth && shown(el))}
      onLoad={(e) => shown(e.currentTarget)}
      onError={(e) => shown(e.currentTarget)}
      style={style}
      className={cn("opacity-0 transition-opacity duration-200", dim ? "data-[in]:opacity-40" : "data-[in]:opacity-100", className)}
    />
  );
}
