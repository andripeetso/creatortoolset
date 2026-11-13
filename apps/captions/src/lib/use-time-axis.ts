import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { clampZoom, fitPps, maxZoomOf, scrollForZoom, scrollToFollow } from "./time-axis";

/**
 * The time axis (lib/time-axis.ts) on a scroller: zoom 1 fits the whole length, ⌥ + scroll or a pinch zooms about the
 * playhead, ⌘ + scroll goes left and right, and `key` takes = / - / \ from the timeline's own key handler. `now` says
 * where the playhead is when asked (a timeline that moves its playhead without a render has no time to hand over as a
 * value); `follow` is for whoever hears the time move.
 *
 * `left` and `right` are the px of the scroller's content before 0:00 and after the end; `maxPps` the widest a second gets.
 */
export function useTimeAxis({ scroller, seconds, left = 0, right = 0, maxPps, now }: {
  scroller: RefObject<HTMLElement | null>;
  seconds: number;
  left?: number;
  right?: number;
  maxPps: number;
  now: () => number;
}) {
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);
  const base = fitPps(width, seconds, left, right);
  const maxZoom = maxZoomOf(base, maxPps);
  const pps = base * zoom;

  // several wheel events can land before a render, so the latest zoom and the scroll it wants live here
  const live = useRef({ zoom: 1, base, maxPps, now, scroll: null as number | null });
  const zoomTo = (target: number) => {
    const el = scroller.current;
    if (!el) return;
    const l = live.current;
    const z = clampZoom(target, l.base, l.maxPps);
    l.scroll = scrollForZoom({ width: el.clientWidth, scroll: l.scroll ?? el.scrollLeft, left }, l.base, l.zoom, z, l.now());
    l.zoom = z;
    setZoom(z);
  };
  const zoomBy = (factor: number) => zoomTo(live.current.zoom * factor);
  const zoomRef = useRef(zoomBy);
  useLayoutEffect(() => {
    Object.assign(live.current, { base, maxPps, now });
    zoomRef.current = zoomBy;
  });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && live.current.scroll !== null) el.scrollLeft = live.current.scroll;
    live.current.scroll = null;
  }, [zoom, scroller]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.altKey || (e.ctrlKey && !e.metaKey)) { // ⌥ + scroll, or a pinch (the browser sends it as Ctrl)
        e.preventDefault();
        zoomRef.current(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.006));
      } else if (e.metaKey) { // ⌘ + scroll: left and right
        e.preventDefault();
        el.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scroller]);

  /** Brings `time` back into view when it has left it (the playhead while it plays). */
  const follow = (time: number) => {
    const el = scroller.current;
    if (!el) return;
    const to = scrollToFollow({ width: el.clientWidth, scroll: el.scrollLeft, left }, live.current.base * live.current.zoom, time);
    if (to !== null) el.scrollLeft = to;
  };
  /** = and + zoom in, - zooms out, \ fits the whole length. True when the key was one of them. */
  const key = (e: KeyboardEvent): boolean => {
    if (e.key === "=" || e.key === "+") zoomBy(1.5);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.5);
    else if (e.key === "\\") zoomTo(1);
    else return false;
    return true;
  };
  return { base, zoom, maxZoom, pps, zoomTo, zoomBy, follow, key };
}
