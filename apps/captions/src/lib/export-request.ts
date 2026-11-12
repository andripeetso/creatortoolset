import { fillCueGaps } from "./captions";
import { DEFAULT_STYLE, type CaptionRenderSpec, type CaptionStyle, type Cue, type PosSegment, type TextOverlay } from "./types";

/**
 * What an export sends, shared by the page (ExportDialog, Send to Finals) and the assistant's captions_export tool
 * (api/mcp-tools/captions.ts), which builds the same request from the project as the server keeps it. Nothing here
 * touches the browser.
 */

/** What a render draws from: a clip's captions, look and overlays, its length and its frame. */
export interface RenderData {
  cues: Cue[];
  style: CaptionStyle;
  posSegments: PosSegment[];
  texts: TextOverlay[];
  duration: number;
  width: number;
  height: number;
}

/** A clip as the server keeps it (GET /api/projects/:id): the parts a render reads. */
export interface StoredClip {
  duration?: number;
  srcWidth?: number;
  srcHeight?: number;
  cues?: Cue[];
  style?: Partial<CaptionStyle>;
  posSegments?: PosSegment[];
  texts?: TextOverlay[];
}

/** The look a stored clip opens with: fitBox is always on now, and old saves predate the lowercase flag. */
export const storedStyle = (style?: Partial<CaptionStyle>): CaptionStyle => ({
  ...DEFAULT_STYLE,
  ...(style ?? {}),
  fitBox: true,
  lowercase: style?.lowercase ?? false,
});

/** A stored clip's texts on screen, with today's defaults for saves that predate newer fields. */
export const storedTexts = (texts?: TextOverlay[]): TextOverlay[] =>
  (texts ?? []).map((t) => ({
    ...t,
    w: t.w ?? 40,
    fontFamily: t.fontFamily ?? "Anton",
    outlineColor: t.outlineColor ?? "#000000",
    outlineWidth: t.outlineWidth ?? 4,
    shadowDepth: t.shadowDepth ?? 0,
    boxEnabled: t.boxEnabled ?? false,
    boxColor: t.boxColor ?? "#000000",
    rotation: t.rotation ?? 0,
  }));

/** What a stored clip renders from: what the page holds for a clip of an opened project (store.ts clipRenderData). */
export function storedRenderData(clip: StoredClip): RenderData {
  const style = storedStyle(clip.style);
  const duration = clip.duration ?? 0;
  const cues = clip.cues ?? [];
  return {
    cues: style.fillGaps ? fillCueGaps(cues, duration) : cues,
    style,
    posSegments: clip.posSegments ?? [],
    texts: storedTexts(clip.texts),
    duration,
    width: clip.srcWidth ?? 0,
    height: clip.srcHeight ?? 0,
  };
}

/** The frames the server draws by itself (engine "wysiwyg"): no text is measured by whoever asks. */
export const renderSpecOf = (d: RenderData): CaptionRenderSpec => ({
  width: d.width,
  height: d.height,
  cues: d.cues,
  style: d.style,
  posSegments: d.posSegments,
  texts: d.texts,
});

/** The project's part of a file name (also what a batch's ZIP is called). */
export const exportBase = (project: string): string =>
  project
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "_");

/**
 * An export's file name, {project}_{clip}: the server appends "-captioned". A clip already named after its project
 * (however the spaces are written) is not given the project's name a second time.
 */
export function exportName(project: string, clip: string): string {
  const base = exportBase(project);
  const cb = (clip || "captions").replace(/\.[^.]+$/, "");
  return !base || exportBase(cb).toLowerCase().startsWith(base.toLowerCase()) ? cb : `${base}_${cb}`;
}
