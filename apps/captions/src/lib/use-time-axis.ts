import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { clampZoom, fitPps, maxZoomOf, scrollForZoom, scrollToFollow } from "./time-axis";

/**
 * The time axis (lib/time-axis.ts) on a scroller: zoom 1 fits the whole length, ⌥ + scroll or a pinch zooms about the
 * playhead, ⌘ + scroll goes left and right, and `key` takes = / - / \ from the timeline's own key handler. `now` says
 * where the playhead is when asked (a timeline that moves its playhead without a render has no time to hand over as a
 * value); `follow` is for whoever hears the time move.
 *
 * `left` and `right` are the px of the scroller's content before 0:00 and after the end; `maxPps` the widest a second
 * gets. A timeline that doesn't open on its whole length gives `startPps`, the width of a second it opens at (never
 * narrower than the whole length fitted, never wider than `maxPps`): taken once the length is known, and again for a
 * new length. A timeline far longer than what is on it gives `fit`, the seconds it opens on and \ fits (from 0:00).
 */
export function useTimeAxis({ scroller, seconds, left = 0, right = 0, maxPps, now, startPps, fit, minPps = 1 }: {
  scroller: RefObject<HTMLElement | null>;
  seconds: number;
  left?: number;
  right?: number;
  maxPps: number;
  now: () => number;
  startPps?: number;
  fit?: number;
  /** the narrowest a second gets (1 px): a timeline of hours needs less to show whole */
  minPps?: number;
}) {
  const [width, setWidth] = useState(600);
  const [asked, setZoom] = useState(1);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);
  const base = fitPps(width, seconds, left, right, minPps);
  const maxZoom = maxZoomOf(base, maxPps);
  // never past the widest a second gets, also when the scroller got wider or the length shorter since the zoom was set
  const zoom = Math.min(asked, maxZoom);
  const pps = base * zoom;

  // several wheel events can land before a render, so the latest zoom and the scroll it wants live here
  const live = useRef({ zoom: 1, base, maxPps, now, fit, scroll: null as number | null });
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
  /** The whole length, or `fit` seconds from 0:00. */
  const zoomFit = () => {
    const el = scroller.current;
    const f = live.current.fit;
    if (!el || !f) return zoomTo(1);
    zoomTo(fitPps(el.clientWidth, f, left, right, minPps) / live.current.base);
    live.current.scroll = 0;
    el.scrollLeft = 0;
  };
  const zoomRef = useRef(zoomBy);
  useLayoutEffect(() => {
    Object.assign(live.current, { zoom, base, maxPps, now, fit });
    zoomRef.current = zoomBy;
  });
  // the width it opens at: measured on the scroller itself, since the first render has no width yet
  useLayoutEffect(() => {
    const el = scroller.current;
    const want = el && (fit ? fitPps(el.clientWidth, fit, left, right, minPps) : startPps);
    if (!el || !want || !(seconds > 0)) return;
    const whole = fitPps(el.clientWidth, seconds, left, right, minPps);
    const z = clampZoom(want / whole, whole, maxPps);
    live.current.zoom = z;
    setZoom(z);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per length
  }, [seconds, scroller]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && live.current.scroll !== null) el.scrollLeft = live.current.scroll;
    live.current.scroll = null;
  }, [zoom, scroller]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // the wheel events of one frame zoom once, drawn in that same frame: the render runs in the frame's own callback
    // (flushSync), not in a task React schedules for later, which could land after the frame was painted
    let factor = 1;
    let frame = 0;
    const wheel = (e: WheelEvent) => {
      if (e.altKey || (e.ctrlKey && !e.metaKey)) { // ⌥ + scroll, or a pinch (the browser sends it as Ctrl)
        e.preventDefault();
        factor *= Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.006);
        frame ||= requestAnimationFrame(() => {
          const f = factor;
          [factor, frame] = [1, 0];
          flushSync(() => zoomRef.current(f));
        });
      } else if (e.metaKey) { // ⌘ + scroll: left and right
        e.preventDefault();
        el.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.dataset.wheel = "snap"; // no glide in the Mac app (lib/mac-wheel.ts)
    return () => {
      el.removeEventListener("wheel", wheel);
      cancelAnimationFrame(frame);
    };
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
    else if (e.key === "\\") zoomFit();
    else return false;
    return true;
  };
  return { base, zoom, maxZoom, pps, zoomTo, zoomBy, zoomFit, follow, key };
}
