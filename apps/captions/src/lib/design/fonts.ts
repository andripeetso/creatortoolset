import { FONT_OPTIONS, fontWeightFor } from "../types";

/**
 * The fonts a design's words can be set in: the captions' own (every one a bold or display face), and three for
 * designs alone: a regular weight for longer text, a serif and a hand. They are not in FONT_OPTIONS: captions and
 * their video export know only those. Each family is one file (public/fonts, src/index.css, src/render-entry.tsx).
 */
export const DESIGN_FONTS: { label: string; family: string }[] = [
  ...FONT_OPTIONS,
  { label: "Poppins Regular", family: "Poppins Regular" },
  { label: "DM Serif Display", family: "DM Serif Display" },
  { label: "Caveat (handwritten)", family: "Caveat" },
];

/** The weight a family's one file is drawn at (of the designs' own, Caveat is drawn at its bold). */
export const designWeight = (family: string): number => (family === "Caveat" ? 700 : fontWeightFor(family));
