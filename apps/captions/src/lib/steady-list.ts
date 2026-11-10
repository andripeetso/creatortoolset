import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * A list that does not shove what the person is looking at when it changes under them (a new item from another
 * device, a job that finished, an item that moved up). Scrolled away from its top, the order on screen stays: items
 * still update in place and a deleted one still goes, but a new one waits, and shows once the list is back at its
 * top. At its top the change is taken at once and glides: each row slides from where it was, a new one fades in.
 * Nothing here moves the page's own scroll, so it is the same in every browser.
 */

/** The order on screen with what left taken out: what a list scrolled away from its top keeps showing. */
export function keptOrder(shown: string[], now: string[]): string[] {
  const has = new Set(now);
  return shown.filter((id) => has.has(id));
}

/** Is the list scrolled away from its top: in its own box, in a box it sits in, or with the page? */
function scrolledAway(el: HTMLElement): boolean {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) if (p.scrollTop > 0) return true;
  return false;
}

type Box = Element | null | undefined;
const childrenOf = (boxes: Box[]) => boxes.flatMap((b) => (b ? [...b.children] : []));
const GLIDE = { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" };

/** Each child slides from where it was (`was`) to where it is; one that was not there fades in. */
function glide(boxes: Box[], was: Map<Element, DOMRect>) {
  const els = childrenOf(boxes);
  // nothing in common is another list altogether (the first load, a folder opened), not an arrival
  if (!els.some((c) => was.has(c)) || !els[0]?.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const now = new Map(els.map((c) => [c, c.getBoundingClientRect()]));
  const moved = new Map<Element, { x: number; y: number }>();
  for (const c of els) {
    const a = was.get(c);
    const b = now.get(c)!;
    if (a) moved.set(c, { x: a.left - b.left, y: a.top - b.top });
  }
  for (const c of els) {
    const d = moved.get(c);
    if (!d) {
      c.animate({ opacity: [0, 1] }, GLIDE);
      continue;
    }
    // inside something that slides itself, a child slides only the rest of the way
    let { x, y } = d;
    for (const [outer, o] of moved) {
      if (outer === c || !outer.contains(c)) continue;
      x -= o.x;
      y -= o.y;
    }
    if (Math.abs(x) >= 1 || Math.abs(y) >= 1) c.animate({ transform: [`translate(${x}px, ${y}px)`, "none"] }, GLIDE);
  }
}

/**
 * `items` in the order to show now. `list` is the element whose children are the rows (they glide, and its place
 * decides whether the list is scrolled away). `scope` names which list this is (a folder, a tab): another scope shows at once.
 * `around`: an element the list sits in whose children also glide when the list's arrival resizes it.
 */
export function useSteadyList<T extends { id: string }>(
  items: T[],
  list: RefObject<HTMLElement | null>,
  opts?: { scope?: string; around?: RefObject<HTMLElement | null> },
): T[] {
  const scope = opts?.scope ?? "";
  const around = opts?.around;
  const ids = items.map((i) => i.id);
  const key = ids.join("\n");
  const [order, setOrder] = useState({ scope, ids });
  const was = useRef<Map<Element, DOMRect> | null>(null);

  const same = order.scope === scope;
  const shownIds = same ? keptOrder(order.ids, ids) : ids;
  const waits = shownIds.join("\n") !== key;

  useLayoutEffect(() => {
    if (!same) return setOrder({ scope, ids });
    if (!waits) return;
    const el = list.current;
    const take = () => {
      was.current = new Map(childrenOf([around?.current, el]).map((c) => [c, c.getBoundingClientRect()]));
      setOrder({ scope, ids });
    };
    if (!el || !scrolledAway(el)) return take();
    // scrolled away: it waits until the list is back at its top (taken within that scroll event, so the glide
    // starts from where the rows are in that very frame)
    const look = () => !scrolledAway(el) && flushSync(take);
    window.addEventListener("scroll", look, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", look, { capture: true });
    // `ids` is `key` as a list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [same, waits, key, scope, list, around]);

  useLayoutEffect(() => {
    const from = was.current;
    was.current = null;
    if (from) glide([around?.current, list.current], from);
  }, [order, list, around]);

  if (!waits) return items;
  const byId = new Map(items.map((i) => [i.id, i]));
  return shownIds.map((id) => byId.get(id)!);
}
