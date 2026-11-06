import type { PostKind, SlideKind } from "./types";

/**
 * Prompting for the per-slide vision pass. The model sees one slide (an
 * image, or a handful of sampled frames from a video) and returns the
 * on-screen text verbatim plus a short description. Slide 1 also reports
 * the hook — the opening line as written on the slide.
 */

export const VISION_SYSTEM = `You analyze one slide of an Instagram post. Return JSON only:
{"on_screen_text":"the slide's message text, verbatim, in reading order, line breaks as \\n, [illegible] for unreadable parts, empty string if there is no text",
 "text_kind":"none if there is no text on screen; captions if the only text is subtitles of what is being said; text if there is other text (titles, lists, labels, a hook), with or without subtitles",
 "description":"1-3 plain sentences: what is shown, who, the setting, the visual style",
 "hook":"slide 1 only: the opening line of the message exactly as written; omit this key on other slides"}
Leave out layout chrome: the creator's name, @handle, avatar and verified badge, watermarks, page counters like "3/10", and swipe arrows or hints. The hook is never the creator's name.
Do not invent text that is not on the slide. Do not summarize the caption. No markdown, no commentary.`;

export interface VisionUserInput {
  creator: string;
  kind: PostKind;
  index: number;
  total: number;
  slideKind: SlideKind;
  durationS?: number;
  caption: string;
  frameTimes?: number[];
}

export function visionUserText(input: VisionUserInput): string {
  const lines = [
    `Creator: @${input.creator}`,
    `Post type: ${input.kind}`,
    `Slide ${input.index + 1} of ${input.total} (${input.slideKind}${
      input.slideKind === "video" && input.durationS
        ? `, ${input.durationS.toFixed(1)}s`
        : ""
    })`,
  ];
  const caption = input.caption.trim();
  if (caption) {
    lines.push(`Caption (context only, not slide text): ${caption.slice(0, 400)}`);
  }
  if (input.slideKind === "video" && input.frameTimes?.length) {
    lines.push(
      `The images are frames sampled at ${input.frameTimes
        .map((t) => `${t.toFixed(1)}s`)
        .join(", ")} — merge the on-screen text across frames, drop duplicates, keep the order text appears in.`,
    );
  }
  return lines.join("\n");
}

/** What the text on screen is: none, only subtitles of the speech, or text of its own. */
export type TextKind = "none" | "captions" | "text";

export interface VisionPayload {
  onScreenText: string;
  textKind?: TextKind;
  description: string;
  hook?: string;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in the answer");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";

export function parseVisionPayload(text: string): VisionPayload {
  const obj = parseJsonObject(text);
  const onScreenText = str(obj.on_screen_text ?? obj.onScreenText, 4000);
  const description = str(obj.description, 600);
  const hook = str(obj.hook, 200);
  const kind = str(obj.text_kind ?? obj.textKind, 20).toLowerCase();
  const textKind: TextKind | undefined = kind === "none" || kind === "captions" || kind === "text" ? kind : undefined;
  if (!description && !onScreenText) {
    throw new Error("the model returned neither text nor a description");
  }
  return { onScreenText, description, ...(hook ? { hook } : {}), ...(textKind ? { textKind } : {}) };
}

/**
 * Where to sample frames in a video slide: the opening, four evenly
 * spaced interior points, and just before the end — deduped for short
 * clips so a 3-second slide gets 2-3 frames, not 6 near-identical ones.
 */
export function frameSampleTimes(durationS: number, frames = 6): number[] {
  const d = Math.max(0, durationS);
  if (d <= 0.6) return [0];
  const want = Math.max(1, Math.min(frames, 12));
  const candidates: number[] = [0.3];
  const interior = Math.max(0, want - 2);
  for (let i = 1; i <= interior; i++) {
    candidates.push((d * i) / (interior + 1));
  }
  candidates.push(Math.max(0.3, d - 0.5));
  const out: number[] = [];
  for (const t of candidates.sort((a, b) => a - b)) {
    const clamped = Math.min(Math.max(0, t), Math.max(0, d - 0.05));
    if (out.length && clamped - out[out.length - 1] < 0.5) continue;
    out.push(Number(clamped.toFixed(2)));
  }
  return out;
}
