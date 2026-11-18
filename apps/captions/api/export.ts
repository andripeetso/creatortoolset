import { existsSync } from "node:fs";
import path from "node:path";

/** The caption fonts and the filter escaping shared by every render that draws text (exports, Caption Studio, the AI Editor). */
export function resolveFontsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "public/fonts"),
    path.resolve(import.meta.dirname, "public/fonts"),
    path.resolve(import.meta.dirname, "../public/fonts"),
    "/app/dist/public/fonts",
    "/app/public/fonts",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Renders must never fall back to system fonts silently — captions come
 * out in the wrong typeface/weight and look nothing like the preview.
 */
export function requireFontsDir(): string {
  const dir = resolveFontsDir();
  if (!dir) {
    throw new Error(
      "Caption fonts not found on the server (public/fonts) — rendering would use the wrong fonts. Start the server from the app directory."
    );
  }
  return dir;
}

/** Escape a value for safe use inside a filter graph expression. */
export function filterEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
