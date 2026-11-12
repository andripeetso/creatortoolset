import { Hono } from "hono";
import { aiFailJson, mayUse, providerFor } from "./ai";
import { anyAiConfigured } from "./ai-complete";
import type { AuthVars } from "./auth";
import { splitPoints, thoughtMarks } from "./lib/cadence-lines";
import { packInstructions } from "./lib/packs";
import { MAX_SCRIPT_CHARS, scriptCheckOpts, scriptEdits } from "./lib/script-check";
import { bumpUsage } from "./users";
import { alignDocumentTokens } from "../src/lib/align";
import { layoutCaptions, layoutGroups, tooWideThoughts, withSplits } from "../src/lib/caption-layout";
import { boxCaps, cadenceFitOf } from "../src/lib/captions";
import { applyScriptEdits } from "../src/lib/script-check";
import { DEFAULT_STYLE, STYLE_PRESETS, type CaptionStyle, type Cue, type Word } from "../src/lib/types";

/**
 * Caption Studio for clients without the editor's layout code (the iPhone
 * app). It runs the web editor's own functions, so a clip captioned on the
 * phone opens on the web laid out the same, and the other way round.
 *
 *   GET  /presets  the style presets
 *   POST /layout   words (+ typed lines) laid out for a style and frame
 *   POST /auto     after transcription: script check, Match cadence, split
 *                  points and layout in one call, as the web runs them
 */
export const captionLayoutApp = new Hono<{ Variables: AuthVars }>();

captionLayoutApp.get("/presets", (c) => c.json({ presets: STYLE_PRESETS }));

interface Input {
  words: Word[];
  style: CaptionStyle;
  width: number;
  height: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finiteOr = (v: unknown, or: number) => (finite(v) ? v : or);

/** Validated words, style and frame, or null. Words keep their ids when they are unique. */
function readInput(body: Record<string, unknown> | null): Input | null {
  const raw = body?.words;
  const { width, height, style } = body ?? {};
  if (!Array.isArray(raw) || raw.length > 50_000) return null;
  if (!finite(width) || !finite(height) || width < 16 || height < 16 || width > 8192 || height > 8192) {
    return null;
  }
  if (!style || typeof style !== "object" || Array.isArray(style)) return null;
  const st = { ...DEFAULT_STYLE, ...(style as Partial<CaptionStyle>), fitBox: true };
  if (![st.fontSizePct, st.boxW, st.boxH].every((v) => finite(v) && v > 0)) return null;

  const words: Word[] = [];
  for (const w of raw as Record<string, unknown>[]) {
    if (!w || typeof w.text !== "string" || !w.text.trim() || !finite(w.start) || !finite(w.end)) {
      return null;
    }
    words.push({
      id: finite(w.id) ? w.id : 0,
      text: w.text.trim(),
      start: w.start,
      end: w.end,
      ...(finite(w.confidence) ? { confidence: w.confidence } : {}),
      ...(finite(w.utterance) ? { utterance: w.utterance } : {}),
      ...(w.timing === "aligned" || w.timing === "approximate" ? { timing: w.timing } : {}),
      ...(w.cut === 0 || w.cut === 1 || w.cut === 2 ? { cut: w.cut } : {}),
    });
  }
  if (new Set(words.map((w) => w.id)).size !== words.length || words.some((w) => w.id <= 0)) {
    words.forEach((w, i) => (w.id = i + 1));
  }
  return { words, style: st, width, height };
}

const counter = (from: number) => () => from++;
const nextWordId = (words: Word[]) => counter(words.reduce((m, w) => Math.max(m, w.id), 0) + 1);

const layout = (words: Word[], inp: Input): Cue[] =>
  layoutCaptions(words, boxCaps(inp.style, inp.width, inp.height), counter(1));

/**
 * Lay out words for the box. With `lines` (the transcript as typed, one
 * caption per line) the typed words are aligned onto the old timings and
 * each line stays one caption, as the web's transcript editor does.
 */
captionLayoutApp.post("/layout", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const inp = readInput(body);
  if (!inp) return c.json({ error: "Malformed words, style or frame" }, 400);
  const lines = body?.lines;
  if (lines === undefined) return c.json({ cues: layout(inp.words, inp) });

  if (
    !Array.isArray(lines) ||
    lines.length > 20_000 ||
    !lines.every((l) => Array.isArray(l) && l.every((t) => typeof t === "string"))
  ) {
    return c.json({ error: "Malformed lines" }, 400);
  }
  const typed = (lines as string[][]).map((l) => l.filter(Boolean)).filter((l) => l.length);
  if (!typed.length) return c.json({ cues: [] });
  const old = inp.words;
  const span = { start: old[0]?.start ?? 0, end: old[old.length - 1]?.end ?? finiteOr(body?.duration, 0) };
  const groups = alignDocumentTokens(typed, old, span, nextWordId(old));
  const cues = layoutGroups(groups, boxCaps(inp.style, inp.width, inp.height), counter(1));
  return c.json({ cues });
});

/**
 * A fresh transcript through the web's automatic passes: the script check
 * (when a script is given), Match cadence, split points for thoughts wider
 * than the box, then the layout. When the AI is off, locked or fails, the
 * plain layout still comes back, with `aiError` saying why.
 */
captionLayoutApp.post("/auto", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const inp = readInput(body);
  if (!inp || !inp.words.length) return c.json({ error: "Malformed words, style or frame" }, 400);
  const script = typeof body?.script === "string" ? body.script.trim().slice(0, MAX_SCRIPT_CHARS) : "";
  const user = c.get("user");
  let words = inp.words;
  const fixes: { before: string; after: string }[] = [];

  const plain = (aiError: string | null) =>
    c.json({ words, cues: layout(words, inp), fixes, cadenceApplied: false, cadenceFit: null, aiError });

  if (!anyAiConfigured(user)) return plain(null);
  if (!mayUse(user)) return plain("The AI caption pass is locked for your account");

  const opts = { signal: c.req.raw.signal, provider: providerFor(user) };
  try {
    if (script) {
      const edits = await scriptEdits(script, words, scriptCheckOpts(user, opts));
      const applied = applyScriptEdits([words], edits, nextWordId(words));
      words = applied.groups.flat();
      fixes.push(...applied.fixes.map(({ before, after }) => ({ before, after })));
      bumpUsage(user.username, { aiRuns: 1 });
    }
    const packText = await packInstructions(user.username, "captions.lines", null, { ai: opts.provider });
    const marks = await thoughtMarks(words, { ...opts, packText });
    bumpUsage(user.username, { aiRuns: 1 });
    words = words.map((w, i) => ({ ...w, cut: marks[i] }));

    const caps = boxCaps(inp.style, inp.width, inp.height);
    const wide = tooWideThoughts(words, caps.maxChars);
    if (wide.length && caps.maxChars >= 8) {
      const splits = await splitPoints(
        wide.map(([a, b]) => words.slice(a, b).map((w) => w.text)),
        Math.floor(caps.maxChars),
        { ...opts, packText },
      );
      words = withSplits(words, wide, splits);
    }
  } catch (e) {
    if (c.req.raw.signal.aborted) return c.json({ error: "Stopped" }, 408);
    words = words.map((w) => ({ ...w, cut: undefined }));
    return plain(aiFailJson(e, "AI caption pass failed").error);
  }
  return c.json({
    words,
    cues: layout(words, inp),
    fixes,
    cadenceApplied: true,
    cadenceFit: cadenceFitOf(inp.style),
    aiError: null,
  });
});
