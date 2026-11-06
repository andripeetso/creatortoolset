export const SHARE_THEME_KEY = "share-theme";
export type ShareTheme = "light" | "dark";

export const SHARE_DARK_BG = "#0b0b10";
export const SHARE_LIGHT_BG = "#fafafa";

export function readShareTheme(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): ShareTheme | null {
  try {
    const v = storage?.getItem(SHARE_THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What the account picked (Settings → Appearance): "light", "dark" or "system". Nothing picked = dark in the app
 * (its tools are drawn dark) and the system's on a public share page.
 */
export function storedThemeChoice(
  share: boolean,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): ShareTheme | "system" {
  try {
    const v = storage?.getItem(SHARE_THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* private mode */
  }
  return share ? "system" : "dark";
}

export function persistShareTheme(
  theme: ShareTheme | "system",
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): void {
  try {
    storage?.setItem(SHARE_THEME_KEY, theme);
  } catch {
    /* private mode */
  }
}

export function systemShareTheme(
  matchesDark = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true,
): ShareTheme {
  return matchesDark ? "dark" : "light";
}

export function resolveShareTheme(
  stored: ShareTheme | null = readShareTheme(),
  system: ShareTheme = systemShareTheme(),
): ShareTheme {
  return stored ?? system;
}

export function applyDocumentTheme(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? SHARE_DARK_BG : SHARE_LIGHT_BG);
}
