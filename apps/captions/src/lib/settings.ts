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
// the person's own colour, used when the project's colour is switched off (a PROJECT_COLORS key; violet until picked)
const OWN_COLOUR_KEY = "appearance:own-colour";
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
/** The wave when chat mode turns on or off (lib/chat-mode.ts washTo); on unless switched off. */
const CHAT_WAVE_KEY = "appearance:chat-wave";
export const storedChatWave = () => storedFlag(CHAT_WAVE_KEY);
export const persistChatWave = (on: boolean) => persistFlag(CHAT_WAVE_KEY, on);

export function storedOwnColour(): string {
  try {
    return localStorage.getItem(OWN_COLOUR_KEY) || "violet";
  } catch {
    return "violet";
  }
}
/** Picks a colour of the person's own: the app stops following the project's colour and uses this one everywhere. */
export function persistOwnColour(colour: string): void {
  try {
    localStorage.setItem(OWN_COLOUR_KEY, colour);
  } catch {
    /* private mode: the choice holds for this visit only */
  }
  persistProjectTint(false);
}

export function useAppearance(): { projectTint: boolean; homeGlow: boolean; chatWave: boolean; ownColour: string } {
  const key = useSyncExternalStore(
    (cb) => {
      window.addEventListener(APPEARANCE_EVENT, cb);
      return () => window.removeEventListener(APPEARANCE_EVENT, cb);
    },
    () => `${+storedProjectTint()}${+storedHomeGlow()}${+storedChatWave()}${storedOwnColour()}`,
  );
  return { projectTint: key[0] === "1", homeGlow: key[1] === "1", chatWave: key[2] === "1", ownColour: key.slice(3) };
}
