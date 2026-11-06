import type { CSSProperties } from "react";
import { fontWeightFor, type TextOverlay } from "./types";

/** Copies per outline ring — a 16-gon is within ~2% of a round outline. */
const RING_STEPS = 16;

/** CSS outline + shadow shared by the interactive and export surfaces. */
export function outlineCss(
  outlineWidth: number,
  outlineColor: string,
  shadowDepth: number
): CSSProperties {
  const parts: string[] = [];
  if (outlineWidth > 0) {
    for (let i = 0; i < RING_STEPS; i++) {
      const a = (i / RING_STEPS) * 2 * Math.PI;
      const dx = (Math.cos(a) * outlineWidth).toFixed(2);
      const dy = (Math.sin(a) * outlineWidth).toFixed(2);
      parts.push(`${dx}px ${dy}px 0 ${outlineColor}`);
    }
  }
  if (shadowDepth > 0) {
    parts.push(`${shadowDepth}px ${shadowDepth}px 2px rgba(0,0,0,.55)`);
  }
  return parts.length ? { textShadow: parts.join(", ") } : {};
}

/** The outer frame shared by interactive and exported text overlays. */
export function textOverlayFrameStyle(
  overlay: TextOverlay,
  frameHeight: number
): CSSProperties {
  const fontPx = (overlay.sizePct / 100) * frameHeight;
  return {
    left: `${overlay.x}%`,
    top: `${overlay.y}%`,
    width: `${overlay.w}%`,
    transform: `translate(-50%, -50%) rotate(${overlay.rotation || 0}deg)`,
    fontFamily: `"${overlay.fontFamily}"`,
    fontWeight: fontWeightFor(overlay.fontFamily),
    fontSize: fontPx,
    lineHeight: 1.18,
    color: overlay.color,
    ...(overlay.boxEnabled
      ? {}
      : outlineCss(
          overlay.outlineWidth * (frameHeight / 1080),
          overlay.outlineColor,
          overlay.shadowDepth * (frameHeight / 1080)
        )),
  };
}
