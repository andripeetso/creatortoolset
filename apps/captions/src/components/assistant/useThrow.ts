import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { settle, type Place } from "@/lib/dock-place";

/** A press that moves less than this is a click. */
const SLOP = 6;
/** The landing: a little past and back. */
const LAND = "transform 460ms cubic-bezier(.3,1.4,.5,1)";

/**
 * Drag or throw the assistant (its bubble, or the chat by its header). While you drag it follows the pointer; on
 * release it settles on the nearest place (settle) and glides there from where you let go. The place is React
 * state, so the move is: draw it at the new place, then animate from the old spot to it (transform only).
 */
export function useThrow(target: RefObject<HTMLElement | null>, canDock: boolean, onPlace: (p: Place) => void) {
  /** True right after a drag, so the click that ends it doesn't also open or press anything. */
  const dragged = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // the header's own buttons are buttons, not handles
    const hit = (e.target as HTMLElement).closest("button,a,input,textarea");
    if (hit && hit !== e.currentTarget) return;
    const el = target.current;
    if (!el) return;
    const handle = e.currentTarget;
    const sx = e.clientX;
    const sy = e.clientY;
    let last = { x: sx, y: sy, t: performance.now() };
    let v = { x: 0, y: 0 };
    let moving = false;
    handle.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moving && Math.hypot(dx, dy) < SLOP) return;
      if (!moving) {
        moving = true;
        el.style.transition = "none";
        el.style.willChange = "transform";
        document.body.style.userSelect = "none";
      }
      const now = performance.now();
      const dt = Math.max(1, now - last.t) / 1000;
      // smoothed release speed, px/s
      v = { x: 0.7 * ((ev.clientX - last.x) / dt) + 0.3 * v.x, y: 0.7 * ((ev.clientY - last.y) / dt) + 0.3 * v.y };
      last = { x: ev.clientX, y: ev.clientY, t: now };
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-6, Math.min(6, v.x / 300))}deg)`;
    };

    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.style.userSelect = "";
      if (!moving) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      // a pause before letting go is a drop, not a throw
      if (performance.now() - last.t > 80) v = { x: 0, y: 0 };
      const place = settle(ev.clientX, ev.clientY, v.x, v.y, window.innerWidth, window.innerHeight, canDock);

      // the tilt off first: a tilted box measures wider, and the glide would start oversized
      el.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
      glide(el, () => onPlace(place));
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  /** Move it somewhere from a button (dock, float), with the same glide. */
  const moveTo = (p: Place) => {
    const el = target.current;
    if (el) glide(el, () => onPlace(p));
    else onPlace(p);
  };

  return { onPointerDown, dragged, moveTo };
}

/** FLIP: where it is now → draw it at the new place → start from the old spot and size → glide in. */
function glide(el: HTMLElement, change: () => void) {
  const before = el.getBoundingClientRect();
  flushSync(change);
  el.style.transform = "";
  const after = el.getBoundingClientRect();
  const done = () => {
    el.style.transition = "";
    el.style.transformOrigin = "";
    el.style.willChange = "";
  };
  if (!after.width || !after.height || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
  el.style.transition = "none";
  el.style.transformOrigin = "top left";
  el.style.transform = `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`;
  void el.offsetWidth;
  el.style.transition = LAND;
  el.style.transform = "";
  // only its own move: a button's or the box's transition inside it bubbles up here too
  const end = (e: TransitionEvent) => {
    if (e.target !== el || e.propertyName !== "transform") return;
    el.removeEventListener("transitionend", end);
    done();
  };
  el.addEventListener("transitionend", end);
  setTimeout(() => {
    el.removeEventListener("transitionend", end);
    done();
  }, 600);
}
