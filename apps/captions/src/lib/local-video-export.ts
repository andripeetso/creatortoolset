import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type VideoSample,
} from "mediabunny";
import {
  boxCaps,
  captionHiddenAt,
  caseText,
  posSegmentAt,
  textOverlayLines,
} from "./captions";
import { cueLineCounts, sliceLines } from "./caption-layout";
import {
  fontWeightFor,
  type CaptionRenderSpec,
  type CaptionStyle,
  type Cue,
  type TextOverlay,
  type Word,
} from "./types";

export type LocalVideoCodec = "h264" | "h265";

export interface LocalVideoExportOptions {
  file: File;
  filename: string;
  codec: LocalVideoCodec;
  spec: CaptionRenderSpec;
  fps: number;
  onProgress?: (progress: number) => void;
}

export async function canExportCaptionedVideoLocal(
  codec: LocalVideoCodec,
  width: number,
  height: number,
): Promise<boolean> {
  if (!("VideoEncoder" in window) || !("VideoDecoder" in window)) return false;
  return canEncodeVideo(codec === "h265" ? "hevc" : "avc", {
    width,
    height,
  }).catch(() => false);
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<FileSystemWritableFileStream>;
  }>;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((part) => part + part)
          .join("")
      : value;
  const r = Number.parseInt(full.slice(0, 2), 16) || 0;
  const g = Number.parseInt(full.slice(2, 4), 16) || 0;
  const b = Number.parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.max(0, radius));
  ctx.fill();
}

function fontString(family: string, size: number): string {
  return `${fontWeightFor(family)} ${size}px "${family}"`;
}

function textWidth(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  style: CaptionStyle,
): number {
  return ctx.measureText(
    words.map((word) => caseText(word.text, style)).join(" "),
  ).width;
}

function drawWordLine(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  style: CaptionStyle,
  currentTime: number,
  centerX: number,
  baselineY: number,
  scale: number,
): void {
  const widths = words.map(
    (word) => ctx.measureText(caseText(word.text, style)).width,
  );
  const space = ctx.measureText(" ").width;
  const total =
    widths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, words.length - 1) * space;
  let x = centerX - total / 2;

  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(0, style.outlineWidth * scale * 2);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const text = caseText(word.text, style);
    const highlighted =
      style.animation === "karaoke" && currentTime >= word.start;
    ctx.fillStyle = highlighted ? style.highlightColor : style.textColor;
    if (!style.boxEnabled && style.shadowDepth > 0) {
      ctx.shadowColor = "rgba(0, 0, 0, .55)";
      ctx.shadowBlur = 2 * scale;
      ctx.shadowOffsetX = style.shadowDepth * scale;
      ctx.shadowOffsetY = style.shadowDepth * scale;
    } else {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    if (!style.boxEnabled && ctx.lineWidth > 0) {
      ctx.strokeStyle = style.outlineColor;
      ctx.strokeText(text, x, baselineY);
    }
    ctx.fillText(text, x, baselineY);
    x += widths[i] + space;
  }
  ctx.shadowColor = "transparent";
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function captionAnimation(
  cue: Cue,
  style: CaptionStyle,
  currentTime: number,
): { alpha: number; scale: number } {
  const elapsed = Math.max(0, currentTime - cue.start);
  if (style.animation === "fade") {
    return { alpha: Math.min(1, elapsed / 0.3), scale: 1 };
  }
  if (style.animation === "pop" && elapsed < 0.28) {
    const p = elapsed / 0.28;
    if (p <= 0.55) {
      return {
        alpha: 1,
        scale: 0.55 + (1.12 - 0.55) * easeOutCubic(p / 0.55),
      };
    }
    return {
      alpha: 1,
      scale: 1.12 + (1 - 1.12) * easeOutCubic((p - 0.55) / 0.45),
    };
  }
  return { alpha: 1, scale: 1 };
}

function wrapWordsByWidth(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  style: CaptionStyle,
  maxWidth: number,
): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  for (const word of words) {
    const candidate = [...line, word];
    if (line.length > 0 && textWidth(ctx, candidate, style) > maxWidth) {
      lines.push(line);
      line = [word];
    } else {
      line = candidate;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  spec: CaptionRenderSpec,
  currentTime: number,
): void {
  const cue = spec.cues.find(
    (candidate) =>
      currentTime >= candidate.start && currentTime < candidate.end,
  );
  if (!cue || captionHiddenAt(spec.posSegments, currentTime)) return;

  const { style, width, height } = spec;
  const fontPx = (style.fontSizePct / 100) * height;
  const lineHeight = fontPx * 1.18;
  const scale = height / 1080;
  ctx.save();
  ctx.font = fontString(style.fontFamily, fontPx);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const lines = style.fitBox
    ? sliceLines(
        cue.words,
        cueLineCounts(cue, boxCaps(style, width, height).maxChars),
      )
    : wrapWordsByWidth(ctx, cue.words, style, width * 0.9);
  if (lines.length === 0) {
    ctx.restore();
    return;
  }

  const segment = posSegmentAt(spec.posSegments, currentTime);
  const centerX = style.fitBox
    ? ((segment?.x ?? style.boxX) / 100) * width
    : width / 2;
  const blockHeight = lines.length * lineHeight;
  const margin = (style.marginVPct / 100) * height;
  const centerY = style.fitBox
    ? ((segment?.y ?? style.boxY) / 100) * height
    : style.position === "top"
      ? margin + blockHeight / 2
      : style.position === "center"
        ? height / 2
        : height - margin - blockHeight / 2;
  const animation = captionAnimation(cue, style, currentTime);
  ctx.globalAlpha = animation.alpha;
  ctx.translate(centerX, centerY);
  ctx.scale(animation.scale, animation.scale);
  ctx.translate(-centerX, -centerY);

  const widest = Math.max(...lines.map((line) => textWidth(ctx, line, style)));
  const padX = fontPx * 0.28;
  const padY = fontPx * 0.12;
  if (style.boxEnabled) {
    ctx.fillStyle = hexToRgba(style.boxColor, style.boxOpacity);
    roundedRect(
      ctx,
      centerX - widest / 2 - padX,
      centerY - blockHeight / 2 - padY,
      widest + padX * 2,
      blockHeight + padY * 2,
      fontPx * 0.18,
    );
  }

  const firstBaseline = centerY - blockHeight / 2 + fontPx;
  lines.forEach((line, index) => {
    drawWordLine(
      ctx,
      line,
      style,
      currentTime,
      centerX,
      firstBaseline + index * lineHeight,
      scale,
    );
  });
  ctx.restore();
}

function drawOverlayLine(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay,
  line: string,
  centerX: number,
  baselineY: number,
  fontPx: number,
  scale: number,
): void {
  const value = line || "\u00a0";
  const width = ctx.measureText(value).width;
  if (overlay.boxEnabled) {
    ctx.fillStyle = overlay.boxColor;
    roundedRect(
      ctx,
      centerX - width / 2 - fontPx * 0.3,
      baselineY - fontPx - fontPx * 0.1,
      width + fontPx * 0.6,
      fontPx * 1.18 + fontPx * 0.2,
      fontPx * 0.24,
    );
  } else if (overlay.shadowDepth > 0) {
    ctx.shadowColor = "rgba(0, 0, 0, .55)";
    ctx.shadowBlur = 2 * scale;
    ctx.shadowOffsetX = overlay.shadowDepth * scale;
    ctx.shadowOffsetY = overlay.shadowDepth * scale;
  }
  ctx.fillStyle = overlay.color;
  if (!overlay.boxEnabled && overlay.outlineWidth > 0) {
    ctx.strokeStyle = overlay.outlineColor;
    ctx.lineWidth = overlay.outlineWidth * scale * 2;
    ctx.lineJoin = "round";
    ctx.strokeText(value, centerX, baselineY);
  }
  ctx.fillText(value, centerX, baselineY);
  ctx.shadowColor = "transparent";
}

function drawTextOverlays(
  ctx: CanvasRenderingContext2D,
  spec: CaptionRenderSpec,
  currentTime: number,
): void {
  for (const overlay of spec.texts) {
    if (currentTime < overlay.start || currentTime >= overlay.end) continue;
    const fontPx = (overlay.sizePct / 100) * spec.height;
    const lineHeight = fontPx * 1.18;
    const lines = textOverlayLines(overlay, spec.width, spec.height);
    const blockHeight = lines.length * lineHeight;
    ctx.save();
    ctx.translate(
      (overlay.x / 100) * spec.width,
      (overlay.y / 100) * spec.height,
    );
    ctx.rotate(((overlay.rotation || 0) * Math.PI) / 180);
    ctx.font = fontString(overlay.fontFamily, fontPx);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const firstBaseline = -blockHeight / 2 + fontPx;
    lines.forEach((line, index) => {
      drawOverlayLine(
        ctx,
        overlay,
        line,
        0,
        firstBaseline + index * lineHeight,
        fontPx,
        spec.height / 1080,
      );
    });
    ctx.restore();
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  sample: VideoSample,
  spec: CaptionRenderSpec,
): HTMLCanvasElement {
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, spec.width, spec.height);
  sample.draw(ctx, 0, 0, spec.width, spec.height);
  drawCaption(ctx, spec, sample.timestamp);
  drawTextOverlays(ctx, spec, sample.timestamp);
  return canvas;
}

function downloadBuffer(buffer: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function localExportError(
  conversion: Conversion,
  codec: LocalVideoCodec,
): Error {
  const reason = conversion.discardedTracks
    .map((item) => item.reason.replaceAll("_", " "))
    .join(", ");
  const codecName = codec === "h265" ? "H.265" : "H.264";
  return new Error(
    `${codecName} cannot be encoded by this browser/device${reason ? ` (${reason})` : ""}. Choose Cloud background render instead.`,
  );
}

/** Burns captions into the retained original File without uploading it. */
export async function exportCaptionedVideoLocal(
  options: LocalVideoExportOptions,
): Promise<void> {
  const { file, codec, spec, fps, onProgress } = options;
  if (!("VideoEncoder" in window) || !("VideoDecoder" in window)) {
    throw new Error(
      "Local video export needs browser video encoding. Use current Chrome or Edge, or choose Cloud background render.",
    );
  }

  // Ask for the destination while the export click still has browser user
  // activation. Font/media setup below can await freely after this point.
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  let writable: FileSystemWritableFileStream | null = null;
  let bufferTarget: BufferTarget | null = null;
  let target: StreamTarget | BufferTarget;
  if (picker) {
    const handle = await picker({
      suggestedName: options.filename,
      types: [
        {
          description: "MP4 video",
          accept: { "video/mp4": [".mp4"] },
        },
      ],
    });
    writable = await handle.createWritable();
    target = new StreamTarget(
      writable as unknown as WritableStream<{
        type: "write";
        data: Uint8Array<ArrayBuffer>;
        position: number;
      }>,
      { chunked: true },
    );
  } else {
    bufferTarget = new BufferTarget();
    target = bufferTarget;
  }

  await Promise.all([
    document.fonts.load(fontString(spec.style.fontFamily, 48)),
    ...spec.texts.map((text) =>
      document.fonts.load(fontString(text.fontFamily, 48)),
    ),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not create the local video renderer.");

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: picker ? false : "in-memory" }),
    target,
  });
  try {
    const sourceAudio = await input.getPrimaryAudioTrack();
    const pixelsPerSecond = spec.width * spec.height * Math.max(1, fps);
    const bitrate = Math.max(
      6_000_000,
      Math.min(40_000_000, pixelsPerSecond * 0.08),
    );
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      showWarnings: false,
      video: {
        codec: codec === "h265" ? "hevc" : "avc",
        quality: new Quality({ bitrate, bitrateMode: "variable" }),
        frameRate: fps > 0 ? fps : undefined,
        forceTranscode: true,
        allowRotationMetadata: false,
        processedWidth: spec.width,
        processedHeight: spec.height,
        process: (sample) => drawFrame(ctx, sample, spec),
      },
    });
    if (
      !conversion.isValid ||
      !conversion.utilizedTracks.some((track) => track.isVideoTrack())
    ) {
      throw localExportError(conversion, codec);
    }
    if (
      sourceAudio &&
      !conversion.utilizedTracks.some((track) => track.isAudioTrack())
    ) {
      throw new Error(
        "This browser cannot preserve the source audio during local export. Choose Cloud background render instead.",
      );
    }
    conversion.onProgress = (progress) => onProgress?.(progress);
    await conversion.execute();
    onProgress?.(1);
    if (bufferTarget?.buffer) {
      downloadBuffer(bufferTarget.buffer, options.filename);
    }
  } catch (error) {
    if (writable && "abort" in writable) {
      await writable.abort(error).catch(() => undefined);
    }
    throw error;
  } finally {
    input.dispose();
  }
}
