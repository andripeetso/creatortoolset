import type { DesignPage } from "@contracts/design";

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
  const n = /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0;
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

/** A typed colour as "#rrggbb", or null: three or six hex digits, with or without the #. */
export function typedHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  return `#${(m[1]!.length === 3 ? m[1]!.replace(/./g, "$&$&") : m[1]!).toLowerCase()}`;
}

/** The colours a design already uses (its frames, fills, words, lines and shadows), the most used first. */
export function coloursOn(pages: readonly DesignPage[], most = 16): string[] {
  const count = new Map<string, number>();
  const add = (c: string | undefined) => {
    const hex = c && typedHex(c);
    if (hex) count.set(hex, (count.get(hex) ?? 0) + 1);
  };
  for (const p of pages) {
    add(p.background);
    for (const l of p.layers) {
      if (l.type === "text") {
        add(l.color);
        add(l.outline?.color);
      }
      if (l.type === "shape") {
        add(l.fill);
        add(l.stroke?.color);
      }
      add(l.shadow?.color);
    }
  }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, most).map(([c]) => c);
}
