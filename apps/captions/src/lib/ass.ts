import {
  boxCaps,
  captionHiddenAt,
  caseText,
  posSegmentAt,
  textOverlayLines,
  wrapLines,
} from "./captions";
import { cueLineCounts, sliceLines } from "./caption-layout";
import {
  assBaselineShift,
  assBoldField,
  assFontSize,
  fontWeightFor,
  type CaptionStyle,
  type Cue,
  type PosSegment,
  type TextOverlay,
} from "./types";

/* ---------- preview parity ----------
 * These mirror the caption block in Player.tsx one for one. The export
 * is WYSIWYG only while they stay in sync — change them together.
 */
const LINE_H = 1.18; // em — CSS line-height
const LETTER_SP = 0.01; // em — CSS letter-spacing
const CAP_PAD_X = 0.28; // em — caption box padding
const CAP_PAD_Y = 0.12; // em
const CAP_RADIUS = 0.18; // em — caption box corner radius
const TXT_PAD_X = 0.3; // em — text-overlay pill padding
const TXT_PAD_Y = 0.1; // em
const TXT_RADIUS = 0.24; // em
/** Overlay pills stack flush (the preview pulls each up by 0.5px). */
const TXT_PILL_OVERLAP = 0.5;

/* ---------- color helpers ---------- */

function hexToAss(hex: string, opacity = 1): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.round((1 - opacity) * 255);
  const p = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${p(a)}${p(b)}${p(g)}${p(r)}`;
}

function escAssText(t: string): string {
  return t.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " ");
}

/** 6-digit BGR color for inline override tags, e.g. \c&H00E6FF& */
function hexToAssColor(hex: string): string {
  const h = hex.replace("#", "");
  const p = (s: string) => s.toUpperCase();
  return `&H${p(h.slice(4, 6))}${p(h.slice(2, 4))}${p(h.slice(0, 2))}&`;
}

/** Alpha override value for \1a — opacity 0.6 → &H66& */
function assAlpha(opacity: number): string {
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
  return `&H${a.toString(16).padStart(2, "0").toUpperCase()}&`;
}

/* ---------- box drawing ---------- */

/** ASS drawing scale (\p4): coordinates carry 1/8 px precision. */
const DRAW_SCALE = 8;

/**
 * Width of one rendered line in frame pixels, measured with the very
 * font the preview paints — that's what lets a drawn box hug the text
 * the same way CSS padding does. Outside the browser (tests) it falls
 * back to the average-glyph estimate the box-capacity math uses.
 */
function lineMeasurer(family: string, fontPx: number) {
  // Match the exact registered browser face weight. This path remains for
  // downloadable ASS sidecars; rendered video uses the CSS surface itself.
  const weight = fontWeightFor(family);
  let ctx: CanvasRenderingContext2D | null = null;
  if (typeof document !== "undefined") {
    ctx = document.createElement("canvas").getContext("2d");
    if (ctx) ctx.font = `${weight} ${fontPx}px "${family}"`;
  }
  return (text: string): number =>
    (ctx ? ctx.measureText(text).width : text.length * fontPx * 0.55) +
    LETTER_SP * fontPx * text.length;
}

/**
 * Rounded rectangle from (0,0) to (w,h) as an ASS \p4 drawing.
 *
 * Anchored top-left on purpose: libass puts a drawing's path origin at
 * \pos and applies the alignment shift on top of that, so a path built
 * around its own center lands half a box up and to the left. With a
 * (0,0)-anchored path and \an7 both readings of the spec agree — and the
 * Box style is declared \an7 too, so a renderer that ignores the inline
 * override (rather than the style) still can't shift the box by half its
 * own size. Separate top/bottom radii let overlay pills stack flush.
 */
function roundRectPath(w: number, h: number, rTop: number, rBot: number): string {
  const s = DRAW_SCALE;
  const lim = Math.min(w, h) / 2;
  const x0 = 0;
  const y0 = 0;
  const x1 = w * s;
  const y1 = h * s;
  const t = Math.max(0, Math.min(rTop, lim)) * s;
  const b = Math.max(0, Math.min(rBot, lim)) * s;
  // control-point inset that turns a cubic into a circular quarter arc
  const kt = t * 0.4477;
  const kb = b * 0.4477;
  const n = (v: number) => Math.round(v);
  return [
    `m ${n(x0 + t)} ${n(y0)}`,
    `l ${n(x1 - t)} ${n(y0)}`,
    `b ${n(x1 - kt)} ${n(y0)} ${n(x1)} ${n(y0 + kt)} ${n(x1)} ${n(y0 + t)}`,
    `l ${n(x1)} ${n(y1 - b)}`,
    `b ${n(x1)} ${n(y1 - kb)} ${n(x1 - kb)} ${n(y1)} ${n(x1 - b)} ${n(y1)}`,
    `l ${n(x0 + b)} ${n(y1)}`,
    `b ${n(x0 + kb)} ${n(y1)} ${n(x0)} ${n(y1 - kb)} ${n(x0)} ${n(y1 - b)}`,
    `l ${n(x0)} ${n(y0 + t)}`,
    `b ${n(x0)} ${n(y0 + kt)} ${n(x0 + kt)} ${n(y0)} ${n(x0 + t)} ${n(y0)}`,
  ].join(" ");
}

/** A filled rounded-rect event at (cx, cy) on the given layer. */
function boxEvent(opts: {
  layer: number;
  start: string;
  end: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rTop: number;
  rBot: number;
  color: string;
  opacity: number;
  prefix?: string;
  extraTags?: string;
}): string {
  const r = Math.round;
  // \an7 + a top-left path: no alignment shift to reason about
  const tags =
    `{\\an7\\pos(${r(opts.cx - opts.w / 2)},${r(opts.cy - opts.h / 2)})` +
    `\\1c${hexToAssColor(opts.color)}` +
    `\\1a${assAlpha(opts.opacity)}\\bord0\\shad0${opts.extraTags ?? ""}\\p4}`;
  return (
    `Dialogue: ${opts.layer},${opts.start},${opts.end},Box,,0,0,0,,` +
    `${opts.prefix ?? ""}${tags}${roundRectPath(opts.w, opts.h, opts.rTop, opts.rBot)}{\\p0}`
  );
}

/* ---------- time helpers ---------- */

export function fmtAssTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

export function fmtSrtTime(t: number, sep = ","): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(x, 3)}`;
}

export function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${d}`;
}

/** NLE-style timecode MM:SS:FF (seconds + frames at the project fps). */
export function fmtTimecode(t: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(Math.max(0, t) * rate + 1e-6);
  const f = totalFrames % rate;
  const secs = Math.floor(totalFrames / rate);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}:${p(f)}`;
}

/* ---------- cue text building ---------- */

interface WordToken {
  text: string;
  kDur: number; // centiseconds this token occupies (incl. following gap)
}

function cueTokens(cue: Cue, style: CaptionStyle): WordToken[] {
  return cue.words.map((w, i) => {
    const next = cue.words[i + 1];
    const end = next ? next.start : cue.end;
    return {
      text: caseText(w.text, style),
      kDur: Math.max(1, Math.round((end - w.start) * 100)),
    };
  });
}

/** Animation tag group applied to every line (and the box) of a cue. */
function animPrefix(style: CaptionStyle): string {
  if (style.animation === "pop") {
    return "{\\fscx55\\fscy55\\t(0,140,\\fscx112\\fscy112)\\t(140,280,\\fscx100\\fscy100)}";
  }
  if (style.animation === "fade") return "{\\fad(140,140)}";
  return "";
}

/** One line's dialogue body, with karaoke timing when enabled. */
function lineBody(ws: WordToken[], karaoke: boolean, kOffset: number): string {
  const lead = karaoke && kOffset > 0 ? `{\\k${kOffset}}` : "";
  return (
    lead +
    ws
      .map((t, i) => {
        const spacer = i < ws.length - 1 ? " " : "";
        const text = escAssText(t.text);
        return karaoke ? `{\\k${t.kDur}}${text}${spacer}` : text + spacer;
      })
      .join("")
  );
}

/* ---------- ASS document ---------- */

export function buildAss(
  cues: Cue[],
  style: CaptionStyle,
  width: number,
  height: number,
  posSegments: PosSegment[] = [],
  texts: TextOverlay[] = []
): string {
  // CSS pixels the preview paints at, and the (larger) ASS size that
  // renders that same height through libass
  const fontPx = (style.fontSizePct / 100) * height;
  const fontSize = assFontSize(style.fontFamily, fontPx);
  const marginV = (style.marginVPct / 100) * height;
  const outline = Math.max(0, style.outlineWidth * (height / 1080));
  const shadow = Math.max(0, style.shadowDepth * (height / 1080));
  const bold = assBoldField(style.fontFamily);
  const karaoke = style.animation === "karaoke";

  const primary = karaoke ? hexToAss(style.highlightColor) : hexToAss(style.textColor);
  const secondary = hexToAss(style.textColor);
  // a box replaces the outline entirely in the preview (textShadow: none)
  const bord = style.boxEnabled ? 0 : outline;
  const shad = style.boxEnabled ? 0 : shadow;

  const header = `[Script Info]
Title: Caption Studio Export
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${style.fontFamily},${fontSize},${primary},${secondary},${hexToAss(style.outlineColor)},${hexToAss("#000000", 0.55)},${bold},0,0,0,100,100,${(LETTER_SP * fontPx).toFixed(2)},0,1,${bord.toFixed(1)},${shad.toFixed(1)},5,0,0,0,1
Style: Box,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Txt,Anton,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,${hexToAss("#000000", 0.55)},0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Every caption is laid out here exactly as the preview lays it out in
  // CSS — measured line widths, 1.18em line pitch, one rounded box
  // around the block — and each line is positioned explicitly. libass
  // never gets to make a layout decision of its own, which is what keeps
  // the render identical to what was on screen.
  const caps = style.fitBox ? boxCaps(style, width, height) : null;
  const maxChars = caps ? caps.maxChars : style.maxCharsPerLine;
  const measure = lineMeasurer(style.fontFamily, fontPx);
  const lineH = LINE_H * fontPx;
  const padX = CAP_PAD_X * fontPx;
  const padY = CAP_PAD_Y * fontPx;
  const radius = CAP_RADIUS * fontPx;
  const prefix = animPrefix(style);
  const baseline = assBaselineShift(style.fontFamily, fontPx);
  const r = Math.round;

  const events: string[] = [];
  for (const c of cues) {
    // the captions layer also gates visibility: cues in a gap don't render
    if (captionHiddenAt(posSegments, (c.start + c.end) / 2)) continue;
    const lines = sliceLines(cueTokens(c, style), cueLineCounts(c, maxChars));
    if (lines.length === 0) continue;
    const start = fmtAssTime(c.start);
    const end = fmtAssTime(c.end);
    const blockH = lines.length * lineH;

    // block center: the caption box (with any position-track override),
    // or the margin-anchored spot in the legacy top/center/bottom mode
    let cx = width / 2;
    let cy: number;
    if (style.fitBox) {
      const seg = posSegmentAt(posSegments, (c.start + c.end) / 2);
      cx = ((seg?.x ?? style.boxX) / 100) * width;
      cy = ((seg?.y ?? style.boxY) / 100) * height;
    } else if (style.position === "top") {
      cy = marginV + blockH / 2;
    } else if (style.position === "center") {
      cy = height / 2;
    } else {
      cy = height - marginV - blockH / 2;
    }

    if (style.boxEnabled) {
      const blockW = Math.max(
        ...lines.map((ws) => measure(ws.map((t) => t.text).join(" ")))
      );
      events.push(
        boxEvent({
          layer: 0,
          start,
          end,
          cx,
          cy,
          w: blockW + 2 * padX,
          h: blockH + 2 * padY,
          rTop: radius,
          rBot: radius,
          color: style.boxColor,
          opacity: style.boxOpacity,
          prefix,
        })
      );
    }

    let kOffset = 0;
    lines.forEach((ws, i) => {
      const y = cy - blockH / 2 + (i + 0.5) * lineH + baseline;
      events.push(
        `Dialogue: 1,${start},${end},Cap,,0,0,0,,` +
          `{\\an5\\pos(${r(cx)},${r(y)})}${prefix}${lineBody(ws, karaoke, kOffset)}`
      );
      kOffset += ws.reduce((a, t) => a + t.kDur, 0);
    });
  }

  // manual text overlays, above the captions: same explicit layout, but
  // boxed overlays get the preview's per-line pills (rounded only where
  // the stacked silhouette is actually exposed)
  for (const t of texts) {
    const tPx = (t.sizePct / 100) * height;
    const tSize = assFontSize(t.fontFamily, tPx);
    const tMeasure = lineMeasurer(t.fontFamily, tPx);
    const tLineH = LINE_H * tPx;
    const tPadX = TXT_PAD_X * tPx;
    const tPadY = TXT_PAD_Y * tPx;
    const tRadius = TXT_RADIUS * tPx;
    const tBold = assBoldField(t.fontFamily);
    const tBord = t.boxEnabled ? 0 : Math.max(0, t.outlineWidth * (height / 1080));
    const tShad = t.boxEnabled ? 0 : Math.max(0, t.shadowDepth * (height / 1080));
    // CSS rotation is clockwise-positive, ASS \frz counter-clockwise;
    // \org keeps every line turning about the overlay's own center
    const cx = (t.x / 100) * width;
    const cy = (t.y / 100) * height;
    const rot = t.rotation ? `\\frz${(-t.rotation).toFixed(1)}\\org(${r(cx)},${r(cy)})` : "";
    const lines = textOverlayLines(t, width, height);
    // boxed lines are their own padded blocks that stack flush
    const pitch = t.boxEnabled ? tLineH + 2 * tPadY - TXT_PILL_OVERLAP : tLineH;
    const blockH = lines.length * pitch;
    const start = fmtAssTime(t.start);
    const end = fmtAssTime(t.end);

    const tBaseline = assBaselineShift(t.fontFamily, tPx);
    lines.forEach((line, i) => {
      const y = cy - blockH / 2 + (i + 0.5) * pitch;
      if (t.boxEnabled) {
        const prev = lines[i - 1];
        const next = lines[i + 1];
        const rTop = i === 0 || line.length > (prev?.length ?? 0) ? tRadius : 0;
        const rBot =
          i === lines.length - 1 || line.length > (next?.length ?? 0) ? tRadius : 0;
        events.push(
          boxEvent({
            layer: 2,
            start,
            end,
            cx,
            cy: y,
            w: tMeasure(line) + 2 * tPadX,
            h: tLineH + 2 * tPadY,
            rTop,
            rBot,
            color: t.boxColor,
            opacity: 1,
            extraTags: rot,
          })
        );
      }
      events.push(
        `Dialogue: 3,${start},${end},Txt,,0,0,0,,` +
          `{\\an5\\pos(${r(cx)},${r(y + tBaseline)})\\fn${t.fontFamily}` +
          (tBold ? `\\b${tBold}` : "") +
          `\\fs${tSize}\\1c${hexToAssColor(t.color)}\\3c${hexToAssColor(t.outlineColor)}` +
          `\\bord${tBord.toFixed(1)}\\shad${tShad.toFixed(1)}${rot}}${escAssText(line)}`
      );
    });
  }

  return header + events.join("\n") + "\n";
}

/* ---------- SRT / VTT ---------- */

function cuePlainLines(cue: Cue, style: CaptionStyle): string[] {
  // box captions keep the lines shown on screen; legacy mode wraps to width
  if (style.fitBox && cue.lines?.length) {
    return sliceLines(cue.words, cueLineCounts(cue, Infinity)).map((ws) =>
      ws.map((w) => caseText(w.text, style)).join(" "),
    );
  }
  return wrapLines(cue.words, style.maxCharsPerLine, style);
}

export function buildSrt(cues: Cue[], style: CaptionStyle): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${cuePlainLines(c, style).join("\n")}`
      )
      .join("\n\n") + "\n"
  );
}

export function buildVtt(cues: Cue[], style: CaptionStyle): string {
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (c) =>
          `${fmtSrtTime(c.start, ".")} --> ${fmtSrtTime(c.end, ".")}\n${cuePlainLines(c, style).join("\n")}`
      )
      .join("\n\n") +
    "\n"
  );
}
