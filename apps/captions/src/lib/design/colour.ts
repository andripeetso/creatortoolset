import type { DesignPage } from "@contracts/design";
import { effectsOf } from "./effects";
import { fillsOf, strokesOf, takesFills, takesStrokes } from "./paint";

/**
 * A colour as the picker works on it: a hue (0 to 360), how strong it is and how light (0 to 1 each), and back to
 * the "#rrggbb" a layer keeps.
 */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function toHsv(hex: string): Hsv {
  // a see-through part ("#rrggbbaa") is not the hue's: alphaOf reads it
  const n = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? parseInt(hex.slice(1, 7), 16) : 0;
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max ? d / max : 0, v: max };
}

export function toHex({ h, s, v }: Hsv): string {
  const part = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[part(5), part(3), part(1)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** A typed colour as "#rrggbb", or "#rrggbbaa" when it is not wholly solid, or null: three, four, six or eight hex digits, with or without the #. */
export function typedHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim());
  if (!m) return null;
  const hex = `#${(m[1]!.length < 6 ? m[1]!.replace(/./g, "$&$&") : m[1]!).toLowerCase()}`;
  return hex.length === 9 && hex.endsWith("ff") ? hex.slice(0, 7) : hex;
}

/** How solid a colour is, 0 to 1 ("#rrggbb" is wholly solid). */
export const alphaOf = (hex: string): number => (/^#[0-9a-f]{8}$/i.test(hex) ? parseInt(hex.slice(7), 16) / 255 : 1);
/** "#rrggbb" with how solid it is: "#rrggbbaa", or the six digits alone when it is wholly solid. */
export const withAlpha = (hex: string, a: number): string => {
  const six = hex.slice(0, 7);
  return a >= 1 ? six : `${six}${Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0")}`;
};

/** The colours a design already uses (its frames, fills, words, lines and shadows), the most used first. */
export function coloursOn(pages: readonly DesignPage[], most = 16): string[] {
  const count = new Map<string, number>();
  const add = (c: string | undefined) => {
    const hex = c && typedHex(c);
    if (hex) count.set(hex, (count.get(hex) ?? 0) + 1);
  };
  for (const p of pages)
    for (const o of [p, ...p.layers]) {
      for (const f of takesFills(o) ? fillsOf(o) : []) {
        if (f.type === "solid") add(f.color);
        if (f.type === "gradient") f.stops.forEach((s) => add(s.color));
      }
      for (const s of takesStrokes(o) ? strokesOf(o) : []) add(s.color);
      if ("type" in o) for (const e of effectsOf(o)) if ("color" in e) add(e.color);
    }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, most).map(([c]) => c);
}
