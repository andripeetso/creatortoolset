import { FONT_OPTIONS, fontWeightFor } from "../types";

/**
 * The fonts a design's words can be set in: the captions' own (every one a bold or display face), and five for
 * designs alone: a regular weight for longer text, a display serif, two heavy slab serifs (a crisp one and a soft
 * one) and a hand. They are not in FONT_OPTIONS: captions and
 * their video export know only those. Each family is one file (public/fonts, src/index.css, src/render-entry.tsx).
 */
export const DESIGN_FONTS: { label: string; family: string }[] = [
  ...FONT_OPTIONS,
  { label: "Poppins Regular", family: "Poppins Regular" },
  { label: "DM Serif Display", family: "DM Serif Display" },
  { label: "Caveat (handwritten)", family: "Caveat" },
  { label: "Bevan (slab serif)", family: "Bevan" },
  { label: "Coustard Black (soft slab serif)", family: "Coustard Black" },
];

/** The weight a family's one file is drawn at (of the designs' own, Caveat is drawn at its bold). */
export const designWeight = (family: string): number => (family === "Caveat" ? 700 : fontWeightFor(family));

/** A face a text can be drawn in: the family it is known by, the weight it is (`css`: the weight it is asked for by), and whether it is the slanted one. */
export interface Face {
  family: string;
  weight: number;
  css: number;
  italic: boolean;
}

/** The app's families that come in several weights, each weight a file of its own, known by its own name. */
const WEIGHTS: Record<string, Record<number, string>> = {
  Inter: { 700: "Inter", 800: "Inter ExtraBold" },
  Montserrat: { 600: "Montserrat SemiBold", 700: "Montserrat", 800: "Montserrat ExtraBold" },
  Oswald: { 600: "Oswald SemiBold", 700: "Oswald" },
  Poppins: { 400: "Poppins Regular", 700: "Poppins" },
};
/** A file that holds every weight between two (src/index.css registers it for the whole range). */
const VARIABLE: Record<string, [number, number]> = { Caveat: [400, 700] };

export const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
const STYLE_WORDS: [RegExp, number | "italic"][] = [
  [/^(thin|hairline)$/i, 100],
  [/^(extra|ultra)\s?light$/i, 200],
  [/^light$/i, 300],
  [/^(regular|normal|book|roman)$/i, 400],
  [/^medium$/i, 500],
  [/^(semi|demi)\s?bold$/i, 600],
  [/^bold$/i, 700],
  [/^(extra|ultra)\s?bold$/i, 800],
  [/^(black|heavy|extra\s?black|ultra\s?black)$/i, 900],
  [/^(italic|oblique)$/i, "italic"],
];

/**
 * An own font's place in its family, from the name its face gives itself ("Superclarendon Black Italic": the family
 * "Superclarendon", 900, slanted). A name with no style words is the family's regular face.
 * shortcut: read from the name alone, so a family whose own name ends in a style word ("Coustard Black" with no plain
 * Coustard) is taken for that weight of a family of one; read the face's OS/2 weight class when that misleads someone.
 */
export function ownFace(name: string): { group: string; weight: number; italic: boolean } {
  const words = name.split(" ");
  let weight = 400;
  let italic = false;
  while (words.length > 1) {
    const last = words.at(-1)!;
    // a two-word style ("Extra Bold") is read as one
    const two = words.length > 2 ? `${words.at(-2)} ${last}` : "";
    const hit = STYLE_WORDS.find(([re]) => two && re.test(two)) ?? STYLE_WORDS.find(([re]) => re.test(last));
    if (!hit) break;
    words.splice(two && hit[0].test(two) ? -2 : -1);
    if (hit[1] === "italic") italic = true;
    else weight = hit[1];
  }
  return { group: words.join(" ").toLowerCase(), weight, italic };
}

/** The person's own fonts in this window (own-fonts.ts and the drawing browser keep it up to date): their faces are a font's weights too. */
let ownNow: readonly string[] = [];
export const setOwnFamilies = (list: readonly string[]): void => void (ownNow = list);

/** Every face of a font's family: the app's weights of it, or the person's own faces of the same family. `own`: the person's own fonts' families. */
export function facesOf(font: string, own: readonly string[] = ownNow): Face[] {
  const group = Object.values(WEIGHTS).find((g) => Object.values(g).includes(font));
  if (group) return Object.entries(group).map(([w, family]) => ({ family, weight: Number(w), css: designWeight(family), italic: false }));
  const range = VARIABLE[font];
  if (range) return Array.from({ length: (range[1] - range[0]) / 100 + 1 }, (_, k) => range[0] + k * 100).map((w) => ({ family: font, weight: w, css: w, italic: false }));
  if (own.includes(font)) {
    const g = ownFace(font).group;
    return own.flatMap((family) => {
      const f = ownFace(family);
      return f.group === g ? [{ family, weight: f.weight, css: 400, italic: f.italic }] : [];
    });
  }
  return [{ family: font, weight: designWeight(font), css: designWeight(font), italic: false }];
}

/** The weights a font's family has a face for, lightest first. */
export const weightsOf = (font: string, own?: readonly string[]): number[] => [...new Set(facesOf(font, own).map((f) => f.weight))].sort((a, b) => a - b);

/**
 * The face a text is drawn in: the font's own, or the face of its family nearest the weight and slant asked for
 * (never a weight made up by the browser). `slant`: italic was asked for and the family has no italic face, so the
 * upright one is leaned over as it is drawn (the same on every machine).
 */
export function faceOf(font: string, weight?: number, italic?: boolean, own?: readonly string[]): { family: string; css: number; weight: number; slant: boolean } {
  const faces = facesOf(font, own);
  const self = faces.find((f) => f.family === font && (weight === undefined || f.weight === weight)) ?? faces.find((f) => f.family === font) ?? faces[0]!;
  const want = weight ?? (VARIABLE[font] ? designWeight(font) : self.weight);
  const slanted = italic ?? self.italic;
  const sloped = faces.filter((f) => f.italic === slanted);
  const pool = sloped.length ? sloped : faces.filter((f) => !f.italic).length ? faces.filter((f) => !f.italic) : faces;
  // the nearest weight; of two as near, the heavier
  const best = pool.reduce((a, b) => (Math.abs(b.weight - want) < Math.abs(a.weight - want) || (Math.abs(b.weight - want) === Math.abs(a.weight - want) && b.weight > a.weight) ? b : a));
  return { family: best.family, css: best.css, weight: best.weight, slant: slanted && !best.italic };
}
