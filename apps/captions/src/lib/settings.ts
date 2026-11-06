import { useSyncExternalStore } from "react";

/**
 * Settings kept on this device (Settings → General). Each one is read where it is used, so this file
 * only holds the ones that have no home of their own. Theme lives in share-theme.ts; the auto cadence
 * in cadence-preference.ts; the Video Notes speed in clip-playback.ts.
 */

const CONFIRM_DELETES_KEY = "settings.confirm-deletes";

/** On unless the owner switched it off. A reversible delete (to the trash, a comment) asks first. */
export function storedConfirmDeletes(): boolean {
  try {
    return localStorage.getItem(CONFIRM_DELETES_KEY) !== "0";
  } catch {
    return true;
  }
}

export function persistConfirmDeletes(on: boolean): void {
  try {
    localStorage.setItem(CONFIRM_DELETES_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the choice holds for this visit only */
  }
}

/** The status colour bar beside each sidebar session: off unless switched on in Settings → General. */
const STATUS_BARS_KEY = "workshop:status-bars";
export function storedStatusBars(): boolean {
  try {
    return localStorage.getItem(STATUS_BARS_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistStatusBars(on: boolean): void {
  try {
    localStorage.setItem(STATUS_BARS_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the choice holds for this visit only */
  }
}

/**
 * Home page look (Settings → Appearance): the tiles take the current project's colour, and a faint
 * glow of it sits behind them. Both on unless switched off. `useAppearance` re-reads when Settings changes them.
 */
const PROJECT_TINT_KEY = "appearance:project-tint";
const HOME_GLOW_KEY = "appearance:home-glow";
const APPEARANCE_EVENT = "appearance-change";

function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}
function persistFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private mode: the choice holds for this visit only */
  }
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}
export const storedProjectTint = () => storedFlag(PROJECT_TINT_KEY);
export const persistProjectTint = (on: boolean) => persistFlag(PROJECT_TINT_KEY, on);
export const storedHomeGlow = () => storedFlag(HOME_GLOW_KEY);
export const persistHomeGlow = (on: boolean) => persistFlag(HOME_GLOW_KEY, on);

export function useAppearance(): { projectTint: boolean; homeGlow: boolean } {
  const key = useSyncExternalStore(
    (cb) => {
      window.addEventListener(APPEARANCE_EVENT, cb);
      return () => window.removeEventListener(APPEARANCE_EVENT, cb);
    },
    () => `${+storedProjectTint()}${+storedHomeGlow()}`,
  );
  return { projectTint: key[0] === "1", homeGlow: key[1] === "1" };
}
