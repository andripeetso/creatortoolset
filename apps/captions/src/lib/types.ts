export interface Word {
  id: number;
  text: string;
  start: number;
  end: number;
  /** Deepgram confidence, 0–1. Absent for older transcripts and local Whisper. */
  confidence?: number;
  /** Deepgram utterance index. A change is a spoken-phrase boundary. */
  utterance?: number;
  /** approximate = local Whisper timings; gaps are not real pauses. */
  timing?: "aligned" | "approximate";
  /**
   * Match cadence mark for the boundary before this word: 2 = a new
   * thought (starts a line), 1 = a fine place to split a line that is too
   * wide, 0 = keep with the previous word. Absent = not matched yet.
   * Independent of the caption box, so resizing re-lays out from it.
   */
  cut?: 0 | 1 | 2;
}

export interface Cue {
  id: number;
  start: number;
  end: number;
  words: Word[];
  /**
   * Word count per on-screen line, written by the layout for the current
   * box. Every renderer draws these; absent or stale = wrap to width.
   */
  lines?: number[];
}

/**
 * A section of the caption position layer. Sections are independent
 * clips; once the track exists it also gates visibility — captions show
 * only inside sections, gaps hide them. x/y override the caption box
 * center for that time range (null = use the global style position).
 * An empty list = no layer edits (captions always visible).
 */
export interface PosSegment {
  id: number;
  start: number;
  end: number;
  x: number | null; // box center X, % of frame width
  y: number | null; // box center Y, % of frame height
}

/**
 * A manually placed text overlay ("text on screen"), its own timeline
 * layer with its own styling, independent of the caption style.
 */
export interface TextOverlay {
  id: number;
  text: string; // may contain \n for manual line breaks
  start: number;
  end: number;
  x: number; // center X, % of frame width
  y: number; // center Y, % of frame height
  w: number; // wrap-box width, % of frame width
  sizePct: number; // font size as % of frame height
  color: string; // hex
  fontFamily: string;
  outlineColor: string; // hex
  outlineWidth: number; // px @1080p reference
  shadowDepth: number;
  boxEnabled: boolean; // background pill behind each line
  boxColor: string; // hex
  rotation: number; // degrees, clockwise (0 = none)
}

/** Quick-apply looks for text overlays (patch on top of the current text). */
export const TEXT_PRESETS: { name: string; patch: Partial<TextOverlay> }[] = [
  {
    name: "Instagram White",
    patch: {
      fontFamily: "Inter",
      color: "#FFFFFF",
      boxEnabled: true,
      boxColor: "#000000",
      outlineWidth: 0,
      shadowDepth: 0,
    },
  },
  {
    name: "Instagram Black",
    patch: {
      fontFamily: "Inter",
      color: "#000000",
      boxEnabled: true,
      boxColor: "#FFFFFF",
      outlineWidth: 0,
      shadowDepth: 0,
    },
  },
];

export type CaptionAnimation = "none" | "karaoke" | "pop" | "fade";
export type CaptionPosition = "top" | "center" | "bottom";

export interface CaptionStyle {
  fontFamily: string; // ASS / fontconfig family name
  fontSizePct: number; // font size as % of frame height
  textColor: string; // hex
  highlightColor: string; // hex — active word color (karaoke)
  outlineColor: string; // hex
  outlineWidth: number; // px @1080p reference
  shadowDepth: number;
  boxEnabled: boolean;
  boxColor: string; // hex
  boxOpacity: number; // 0..1
  uppercase: boolean;
  /** Force all-lowercase (mutually exclusive with uppercase). */
  lowercase: boolean;
  position: CaptionPosition;
  marginVPct: number; // distance from edge as % of frame height
  animation: CaptionAnimation;
  wordsPerCaption: number; // 0 = smart phrases
  maxCharsPerLine: number;
  /** Captions are segmented + placed by the bounding box on the video. */
  fitBox: boolean;
  boxX: number; // box center X, % of frame width
  boxY: number; // box center Y, % of frame height
  boxW: number; // box width, % of frame width
  boxH: number; // box height, % of frame height
  /**
   * Fill gaps is on: every caption stays up until the next one starts,
   * through every re-layout. store.ts re-applies it whenever captions are rebuilt.
   */
  fillGaps?: boolean;
}

/**
 * Complete visual state for one export frame. The server renders this with
 * the same React/CSS surface as Player instead of translating it to ASS.
 */
export interface CaptionRenderSpec {
  width: number;
  height: number;
  cues: Cue[];
  style: CaptionStyle;
  posSegments: PosSegment[];
  texts: TextOverlay[];
}

export type TranscribeStatus =
  | { phase: "idle" }
  | { phase: "extracting"; progress?: number; detail?: string }
  | { phase: "loading"; progress: number; detail: string }
  | { phase: "transcribing"; progress: number; chunk?: string }
  /** Transcript being checked against the project's script (AI). */
  | { phase: "checking" }
  /** Auto cadence pass running right after a transcription landed. */
  | { phase: "matching" }
  | { phase: "done" }
  | { phase: "error"; message: string };

export type ExportFormat =
  "mp4" | "hevc" | "mov" | "webm" | "png" | "srt" | "vtt" | "ass";

export const FONT_OPTIONS: { label: string; family: string }[] = [
  { label: "Anton", family: "Anton" },
  { label: "Archivo Black", family: "Archivo Black" },
  { label: "Bebas Neue", family: "Bebas Neue" },
  { label: "Inter Bold", family: "Inter" },
  { label: "Inter ExtraBold", family: "Inter ExtraBold" },
  { label: "Montserrat SemiBold", family: "Montserrat SemiBold" },
  { label: "Montserrat Bold", family: "Montserrat" },
  { label: "Montserrat ExtraBold", family: "Montserrat ExtraBold" },
  { label: "Oswald SemiBold", family: "Oswald SemiBold" },
  { label: "Oswald Bold", family: "Oswald" },
  { label: "Poppins Bold", family: "Poppins" },
];

/**
 * Numeric font weight each bundled family name renders at. Each alias maps
 * to one font file, and both preview and CSS export request its real weight.
 */
export const FONT_WEIGHTS: Record<string, number> = {
  Inter: 700,
  "Inter ExtraBold": 800,
  Montserrat: 700,
  "Montserrat SemiBold": 600,
  "Montserrat ExtraBold": 800,
  Oswald: 700,
  "Oswald SemiBold": 600,
  Poppins: 700,
};

/** The exact CSS weight registered for a bundled face. */
export function fontWeightFor(family: string): number {
  return FONT_WEIGHTS[family] ?? 400;
}

/**
 * Value for the ASS `Bold` field (and `\b`) for a family.
 *
 * Current libass reads a number here as a real TrueType weight, but the
 * format only ever specified a flag, and renderers that still treat it
 * as one turn any non-zero value into "make this bold" — which SYNTHESIZES
 * a fake bold when the matched face is lighter than 700. That is what
 * wrecks the SemiBold cuts: asking for 600 gets an emboldened SemiBold
 * instead of the real one, so the export stops matching the preview.
 *
 * Only 700+ is safe to state numerically (there the flag reading and the
 * weight reading agree). Below that, ask for nothing and let the family
 * name carry it: each alias here maps to exactly one bundled file, so
 * "Montserrat SemiBold" already resolves to the SemiBold cut on its own.
 */
export function assBoldField(family: string): number {
  const w = FONT_WEIGHTS[family] ?? 0;
  return w >= 700 ? w : 0;
}

/**
 * CSS px → ASS Fontsize, per family.
 *
 * libass does NOT size text the way CSS does: it scales the face by
 * hhea(ascender-descender) / OS/2(winAscent+winDescent), so a glyph
 * rendered at `Fontsize: 48` comes out far smaller than CSS
 * `font-size: 48px` — and by a different amount for every font (36%
 * short for Montserrat, 45% for Poppins). Without this
 * correction the export is a shrunken version of the preview, which
 * reads as a completely different font and a box with too much padding.
 *
 * Measured by rendering "HHHH" at Fontsize 100 through ffmpeg/libass and
 * comparing cap height against the same face at 100px em (identical on
 * macOS libass 0.17 and the server's 4.4.x). Re-measure when adding a
 * font — see docs/FONT-METRICS.md.
 */
export const FONT_ASS_SCALE: Record<string, number> = {
  Anton: 1.755,
  "Archivo Black": 1.353,
  "Bebas Neue": 1.296,
  Inter: 1.44,
  "Inter ExtraBold": 1.44,
  Montserrat: 1.556,
  "Montserrat SemiBold": 1.556,
  "Montserrat ExtraBold": 1.556,
  Oswald: 1.688,
  "Oswald SemiBold": 1.688,
  Poppins: 1.821,
};

/** ASS Fontsize that renders `fontPx` CSS pixels tall for this family. */
export function assFontSize(family: string, fontPx: number): number {
  return Math.round(fontPx * (FONT_ASS_SCALE[family] ?? 1.5));
}

/**
 * Vertical nudge, in em, from where libass puts a \an5-centered line to
 * where CSS puts it. The two disagree because libass centers a line on
 * its font metrics while CSS centers the line box and drops the baseline
 * by half-leading — worth ~13px at a 100px caption in Anton, i.e. a
 * visibly lower caption than the preview.
 *
 * Measured as (CSS baseline − libass baseline) with the same face at the
 * same em; see docs/FONT-METRICS.md.
 */
export const FONT_ASS_BASELINE: Record<string, number> = {
  Anton: -0.125,
  "Archivo Black": -0.025,
  "Bebas Neue": 0,
  Inter: -0.035,
  "Inter ExtraBold": -0.035,
  Montserrat: 0.03,
  "Montserrat SemiBold": 0.03,
  "Montserrat ExtraBold": 0.03,
  Oswald: -0.02,
  "Oswald SemiBold": -0.02,
  Poppins: 0.09,
};

/** Baseline correction in pixels for a line rendered at `fontPx`. */
export function assBaselineShift(family: string, fontPx: number): number {
  return (FONT_ASS_BASELINE[family] ?? 0) * fontPx;
}

export const STYLE_PRESETS: { name: string; style: CaptionStyle }[] = [
  {
    name: "Classic",
    style: {
      fontFamily: "Montserrat",
      fontSizePct: 2.5,
      textColor: "#FFFFFF",
      highlightColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 0,
      shadowDepth: 0,
      boxEnabled: true,
      boxColor: "#000000",
      boxOpacity: 1,
      uppercase: false,
      lowercase: false,
      position: "bottom",
      marginVPct: 7,
      animation: "none",
      wordsPerCaption: 3,
      maxCharsPerLine: 24,
      fitBox: true,
      // 1080×1920 reference: centered, y 1227px, 740×80px box, 48px text
      boxX: 50,
      boxY: 63.9,
      boxW: 68.5,
      boxH: 4.17,
    },
  },
  {
    name: "Creator (karaoke)",
    style: {
      fontFamily: "Anton",
      fontSizePct: 5.2,
      textColor: "#FFFFFF",
      highlightColor: "#FFE600",
      outlineColor: "#000000",
      outlineWidth: 5,
      shadowDepth: 0,
      boxEnabled: false,
      boxColor: "#000000",
      boxOpacity: 0.6,
      uppercase: true,
      lowercase: false,
      position: "center",
      marginVPct: 8,
      animation: "karaoke",
      wordsPerCaption: 2,
      maxCharsPerLine: 20,
      fitBox: true,
      boxX: 50,
      boxY: 55,
      boxW: 70,
      boxH: 24,
    },
  },
  {
    name: "Classic",
    style: {
      fontFamily: "Inter",
      fontSizePct: 3.4,
      textColor: "#FFFFFF",
      highlightColor: "#3B82F6",
      outlineColor: "#000000",
      outlineWidth: 3,
      shadowDepth: 2,
      boxEnabled: false,
      boxColor: "#000000",
      boxOpacity: 0.6,
      uppercase: false,
      lowercase: false,
      position: "bottom",
      marginVPct: 6,
      animation: "none",
      wordsPerCaption: 0,
      maxCharsPerLine: 38,
      fitBox: true,
      boxX: 50,
      boxY: 84,
      boxW: 80,
      boxH: 14,
    },
  },
  {
    name: "Boxed",
    style: {
      fontFamily: "Montserrat ExtraBold",
      fontSizePct: 3.6,
      textColor: "#FFFFFF",
      highlightColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 3,
      shadowDepth: 0,
      boxEnabled: true,
      boxColor: "#7C3AED",
      boxOpacity: 0.85,
      uppercase: true,
      lowercase: false,
      position: "bottom",
      marginVPct: 7,
      animation: "pop",
      wordsPerCaption: 3,
      maxCharsPerLine: 24,
      fitBox: true,
      boxX: 50,
      boxY: 82,
      boxW: 76,
      boxH: 16,
    },
  },
  {
    name: "Minimal",
    style: {
      fontFamily: "Inter ExtraBold",
      fontSizePct: 3.0,
      textColor: "#FFFFFF",
      highlightColor: "#34D399",
      outlineColor: "#000000",
      outlineWidth: 2,
      shadowDepth: 1,
      boxEnabled: false,
      boxColor: "#000000",
      boxOpacity: 0.6,
      uppercase: false,
      lowercase: false,
      position: "bottom",
      marginVPct: 5,
      animation: "fade",
      wordsPerCaption: 0,
      maxCharsPerLine: 42,
      fitBox: true,
      boxX: 50,
      boxY: 86,
      boxW: 80,
      boxH: 12,
    },
  },
];

export const DEFAULT_STYLE: CaptionStyle = STYLE_PRESETS[0].style;
