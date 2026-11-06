import { useCallback, useEffect, useState, type RefObject } from "react";

/** Loom's viewer speeds, including the 1.2× default they start everyone on. */
export const CLIP_SPEEDS = [0.8, 1, 1.2, 1.5, 1.7, 2, 2.5] as const;
export type ClipSpeed = (typeof CLIP_SPEEDS)[number];

export const DEFAULT_CLIP_SPEED: ClipSpeed = 1.2;

const KEY = "clips-playback-speed";

export function isClipSpeed(n: number): n is ClipSpeed {
  return (CLIP_SPEEDS as readonly number[]).includes(n);
}

export function loadClipSpeed(): ClipSpeed {
  try {
    const n = Number(localStorage.getItem(KEY));
    if (isClipSpeed(n)) return n;
  } catch {
    /* private mode */
  }
  return DEFAULT_CLIP_SPEED;
}

export function saveClipSpeed(rate: ClipSpeed) {
  try {
    localStorage.setItem(KEY, String(rate));
  } catch {
    /* private mode */
  }
}

export function formatClipSpeed(rate: number): string {
  return `${rate}x`;
}

export function nudgeClipSpeed(current: number, dir: -1 | 1): ClipSpeed {
  const i = CLIP_SPEEDS.findIndex((s) => s === current);
  const at = i < 0 ? CLIP_SPEEDS.indexOf(DEFAULT_CLIP_SPEED) : i;
  return CLIP_SPEEDS[Math.max(0, Math.min(CLIP_SPEEDS.length - 1, at + dir))];
}

export function useClipPlaybackRate(
  videoRef: RefObject<HTMLVideoElement | null>,
) {
  const [rate, setRateState] = useState(loadClipSpeed);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      v.playbackRate = rate;
    };
    apply();
    v.addEventListener("loadedmetadata", apply);
    return () => v.removeEventListener("loadedmetadata", apply);
  }, [rate, videoRef]);

  const setRate = useCallback(
    (next: ClipSpeed) => {
      setRateState(next);
      saveClipSpeed(next);
      const v = videoRef.current;
      if (v) v.playbackRate = next;
    },
    [videoRef],
  );

  return { rate, setRate };
}

/** One video at a time in the page — the one that just started playing. */
export function pauseOtherVideos(active: HTMLMediaElement) {
  for (const v of document.querySelectorAll("video")) {
    if (v !== active && !v.paused) v.pause();
  }
}

/** Drop the media resource. Pause is not enough on iOS — src keeps fetching. */
export function releaseVideo(v: HTMLVideoElement) {
  v.pause();
  v.removeAttribute("src");
  v.load();
}

export function releaseAllVideos() {
  for (const v of document.querySelectorAll("video")) releaseVideo(v);
}

export function releaseOtherVideos(keep?: ParentNode | null) {
  const parked: { el: HTMLVideoElement; src: string }[] = [];
  for (const v of document.querySelectorAll("video")) {
    if (keep?.contains(v)) continue;
    const src = v.getAttribute("src") || "";
    if (src) parked.push({ el: v, src });
    if (src || v.currentSrc) releaseVideo(v);
  }
  return parked;
}

export function restoreVideos(
  parked: { el: HTMLVideoElement; src: string }[],
) {
  for (const { el, src } of parked) {
    if (!el.isConnected || !src) continue;
    el.src = src;
  }
}

/** Inclusive playback window from `/clips/<id>?t=&end=` (seconds). */
export function parseClipRangeParams(search: string): {
  start?: number;
  end?: number;
} {
  const q = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const t = q.get("t");
  const endRaw = q.get("end");
  const start = t == null || t === "" ? Number.NaN : Number(t);
  const end = endRaw == null || endRaw === "" ? Number.NaN : Number(endRaw);
  return {
    ...(Number.isFinite(start) && start >= 0 ? { start } : {}),
    ...(Number.isFinite(end) && end > 0 ? { end } : {}),
  };
}

export function clipPlayWindow(
  duration: number,
  start?: number,
  end?: number,
): { lo: number; hi: number } {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const lo =
    start != null && Number.isFinite(start)
      ? Math.max(0, d > 0 ? Math.min(start, d) : start)
      : 0;
  let hi = end != null && Number.isFinite(end) ? end : d;
  if (d > 0) hi = Math.min(d, hi);
  if (!(hi > lo)) hi = d > lo ? d : lo;
  return { lo, hi };
}

export function clampToWindow(t: number, lo: number, hi: number): number {
  const cap = hi > lo ? hi : t;
  return Math.max(lo, Math.min(cap || t, t));
}

export function atWindowEnd(t: number, lo: number, hi: number): boolean {
  return hi > lo && t >= hi - 0.05;
}
