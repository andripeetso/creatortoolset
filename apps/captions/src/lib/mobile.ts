/**
 * Mobile detection + the "prefer desktop" escape hatch. The hub (/)
 * redirects phones to the PWA hub (/m). Older builds let the user opt
 * out of the redirect ("use the desktop version") — that choice is still
 * honored here, but nothing sets it anymore.
 */

const DESKTOP_PREF_KEY = "cap-prefer-desktop";

export function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  return coarse && window.innerWidth < 1024;
}

export function prefersDesktop(): boolean {
  try {
    return localStorage.getItem(DESKTOP_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

/** Phones use the compact hub at /m (also the PWA start URL). */
export function isPhoneHub(): boolean {
  return isMobileDevice() && !prefersDesktop();
}

/** A phone screen's own route: /m and what is under it. Not a page whose name only starts with m (a plug-in's /media). */
export const isPhonePath = (pathname: string): boolean => pathname === "/m" || pathname.startsWith("/m/");

export function toolsetHomePath(): string {
  return isPhoneHub() ? "/m" : "/";
}
