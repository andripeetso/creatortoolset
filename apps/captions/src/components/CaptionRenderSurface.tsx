import type { CSSProperties } from "react";
import { useMemo } from "react";
import {
  boxCaps,
  captionHiddenAt,
  caseText,
  posSegmentAt,
  textOverlayLines,
} from "@/lib/captions";
import { cueLineCounts, sliceLines } from "@/lib/caption-layout";
import { outlineCss, textOverlayFrameStyle } from "@/lib/caption-css";
import {
  fontWeightFor,
  type CaptionRenderSpec,
  type CaptionStyle,
  type Cue,
  type TextOverlay,
  type Word,
} from "@/lib/types";

function captionOutline(style: CaptionStyle, scale: number): CSSProperties {
  return outlineCss(
    style.outlineWidth * scale,
    style.outlineColor,
    style.shadowDepth * scale
  );
}

/** #rrggbb + 0..1 alpha → rgba(), so a box never fades its text. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function WordSpan({
  w,
  text,
  last,
  style,
  currentTime,
  scale,
}: {
  w: Word;
  text: string;
  last: boolean;
  style: CaptionStyle;
  currentTime: number;
  scale: number;
}) {
  const karaoke = style.animation === "karaoke";
  const active = karaoke && currentTime >= w.start;
  const color = karaoke
    ? active
      ? style.highlightColor
      : style.textColor
    : style.textColor;
  return (
    <span
      style={{
        color,
        ...(style.boxEnabled ? {} : captionOutline(style, scale)),
      }}
    >
      {text}
      {last ? "" : " "}
    </span>
  );
}

function animationStyle(
  cue: Cue,
  style: CaptionStyle,
  currentTime: number,
  deterministic: boolean
): CSSProperties {
  const animation =
    style.animation === "pop"
      ? "cap-pop 0.28s ease-out"
      : style.animation === "fade"
        ? "cap-fade 0.3s ease-in"
        : "";
  if (!animation) return {};
  if (!deterministic) return { animation };

  // A paused animation with a negative delay samples the exact timeline
  // position. Every exported frame is deterministic rather than depending
  // on how quickly Chromium happened to capture the previous frame.
  const elapsed = Math.max(0, currentTime - cue.start);
  return {
    animation,
    animationDelay: `-${elapsed}s`,
    animationPlayState: "paused",
    animationFillMode: "both",
  };
}

export function CaptionVisual({
  rect,
  layoutWidth,
  layoutHeight,
  cues,
  style,
  posSegments,
  currentTime,
  deterministicAnimations = false,
}: {
  rect: { w: number; h: number };
  layoutWidth: number;
  layoutHeight: number;
  cues: Cue[];
  style: CaptionStyle;
  posSegments: CaptionRenderSpec["posSegments"];
  currentTime: number;
  deterministicAnimations?: boolean;
}) {
  const cue = useMemo(
    () => cues.find((c) => currentTime >= c.start && currentTime < c.end),
    [cues, currentTime]
  );
  if (!cue || captionHiddenAt(posSegments, currentTime)) return null;

  const seg = posSegmentAt(posSegments, currentTime);
  const boxX = seg?.x ?? style.boxX;
  const boxY = seg?.y ?? style.boxY;
  const fontPx = (style.fontSizePct / 100) * rect.h;
  const margin = (style.marginVPct / 100) * rect.h;
  const scale = rect.h / 1080;
  const text = (w: Word) => caseText(w.text, style);

  const blockStyle: CSSProperties = {
    fontFamily: `"${style.fontFamily}"`,
    fontWeight: fontWeightFor(style.fontFamily),
    fontSize: fontPx,
    lineHeight: 1.18,
    letterSpacing: "0.01em",
    ...(style.boxEnabled
      ? {
          background: hexToRgba(style.boxColor, style.boxOpacity),
          borderRadius: fontPx * 0.18,
          padding: `${fontPx * 0.12}px ${fontPx * 0.28}px`,
          boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone",
        }
      : {}),
    ...animationStyle(
      cue,
      style,
      currentTime,
      deterministicAnimations
    ),
  };

  if (style.fitBox) {
    const { maxChars } = boxCaps(style, layoutWidth, layoutHeight);
    const lines = sliceLines(cue.words, cueLineCounts(cue, maxChars));
    return (
      <div
        className="pointer-events-none absolute flex items-center justify-center"
        style={{
          left: `${boxX - style.boxW / 2}%`,
          top: `${boxY - style.boxH / 2}%`,
          width: `${style.boxW}%`,
          height: `${style.boxH}%`,
        }}
      >
        <div key={cue.id} className="text-center" style={blockStyle}>
          {lines.map((line, li) => (
            <div key={li} className="whitespace-nowrap">
              {line.map((w, i) => (
                <WordSpan
                  key={w.id}
                  w={w}
                  text={text(w)}
                  last={i === line.length - 1}
                  style={style}
                  currentTime={currentTime}
                  scale={scale}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center px-[5%]"
      style={
        style.position === "top"
          ? { top: margin }
          : style.position === "center"
            ? { top: "50%", transform: "translateY(-50%)" }
            : { bottom: margin }
      }
    >
      <div key={cue.id} className="max-w-full text-center" style={blockStyle}>
        <span
          style={{
            display: "inline-block",
            maxWidth: "100%",
            overflowWrap: "break-word",
          }}
        >
          {cue.words.map((w, i) => (
            <WordSpan
              key={w.id}
              w={w}
              text={text(w)}
              last={i === cue.words.length - 1}
              style={style}
              currentTime={currentTime}
              scale={scale}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

/** Non-editing text body shared byte-for-byte by preview and export. */
export function TextOverlayVisual({
  overlay,
  frameWidth,
  frameHeight,
  displayHeight = frameHeight,
}: {
  overlay: TextOverlay;
  frameWidth: number;
  frameHeight: number;
  displayHeight?: number;
}) {
  const lines = textOverlayLines(overlay, frameWidth, frameHeight);
  const fontPx = (overlay.sizePct / 100) * displayHeight;
  const radius = fontPx * 0.24;
  return lines.map((line, i) => {
    if (!overlay.boxEnabled) {
      return (
        <div key={i} className="whitespace-nowrap">
          {line || " "}
        </div>
      );
    }
    const rTop =
      i === 0 || line.length > lines[i - 1].length ? radius : 0;
    const rBottom =
      i === lines.length - 1 || line.length > lines[i + 1].length
        ? radius
        : 0;
    return (
      <div
        key={i}
        style={{
          background: overlay.boxColor,
          borderRadius: `${rTop}px ${rTop}px ${rBottom}px ${rBottom}px`,
          padding: `${fontPx * 0.1}px ${fontPx * 0.3}px`,
          width: "fit-content",
          whiteSpace: "nowrap",
          margin: i > 0 ? "-0.5px auto 0" : "0 auto",
        }}
      >
        {line || " "}
      </div>
    );
  });
}

/** Transparent, interaction-free frame captured by the export worker. */
export function CaptionRenderSurface({
  spec,
  currentTime,
}: {
  spec: CaptionRenderSpec;
  currentTime: number;
}) {
  const visibleTexts = spec.texts.filter(
    (t) => currentTime >= t.start && currentTime < t.end
  );
  return (
    <div
      style={{
        position: "relative",
        width: spec.width,
        height: spec.height,
        overflow: "hidden",
        background: "transparent",
      }}
    >
      <CaptionVisual
        rect={{ w: spec.width, h: spec.height }}
        layoutWidth={spec.width}
        layoutHeight={spec.height}
        cues={spec.cues}
        style={spec.style}
        posSegments={spec.posSegments}
        currentTime={currentTime}
        deterministicAnimations
      />
      {visibleTexts.map((t) => (
        <div
          key={t.id}
          className="absolute rounded-sm text-center"
          style={textOverlayFrameStyle(t, spec.height)}
        >
          <TextOverlayVisual
            overlay={t}
            frameWidth={spec.width}
            frameHeight={spec.height}
            displayHeight={spec.height}
          />
        </div>
      ))}
    </div>
  );
}
