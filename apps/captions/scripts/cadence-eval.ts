/**
 * Score Match cadence against hand-approved caption lines.
 *
 *   npx tsx scripts/cadence-eval.ts [kimi|openai|anthropic ...] [--box 28x1]
 *     [--piece 120]  words per request (0 = the whole reel in one request)
 *     [--width]      then plan split points for the --box width, as the app does
 *     [--save marks.json]
 *
 * Runs each provider on the real reel in src/lib/__fixtures__ (the same
 * prompt and alignment /api/ai/segment uses) and compares the thought
 * lines it returns with the reference. The opening lines are the prompt's
 * own style examples, so only the rest of the reel is scored.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import type { ProviderId } from "../api/ai-complete";
import { layoutCues } from "../src/lib/captions";
import { cueLineCounts, sliceLines, unplannedBreaks } from "../src/lib/caption-layout";
import {
  longThoughts,
  PIECE_WORDS,
  splitPoints,
  thoughtMarks,
  type Mark,
} from "../api/lib/cadence-lines";

const FIXTURES = new URL("../src/lib/__fixtures__/", import.meta.url);
const fx = JSON.parse(readFileSync(new URL("cadence-clip-01.json", FIXTURES), "utf8")) as {
  approved: string[];
  windowStepS: number;
  words: { text: string; start: number; end: number; utterance?: number }[];
};
const reference = readFileSync(new URL("cadence-clip-01.reference.txt", FIXTURES), "utf8")
  .trim()
  .split("\n");

// the words as the fixed seam merge keeps them
const cut = (k: number) => (k === 0 ? -Infinity : k * fx.windowStepS + 1);
const words = fx.words.filter((w) => {
  const k = Math.floor((w.utterance ?? 0) / 1000);
  return w.start >= cut(k) && w.start < cut(k + 1);
});
const heldOut = fx.approved.join(" ").split(" ").length;

const referenceStarts = new Set<number>();
{
  let at = heldOut;
  for (const line of reference) {
    referenceStarts.add(at);
    at += line.split(" ").length;
  }
}

function linesFrom(marks: Mark[], from: number): string[] {
  const lines: string[] = [];
  for (let i = from; i < words.length; i++) {
    if (i === from || marks[i] === 2) lines.push(words[i].text);
    else lines[lines.length - 1] += " " + words[i].text;
  }
  return lines;
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const box = option("--box")?.split("x").map(Number) ?? null;
const savePath = option("--save");
const piece = option("--piece");
const pieceWords = piece === null ? PIECE_WORDS : Number(piece) || Infinity;
const optionValues = new Set([option("--box"), option("--save"), piece]);
const named = args.filter((a) => !a.startsWith("--") && !optionValues.has(a)) as ProviderId[];
const providers = named.length ? named : (["kimi", "openai", "anthropic"] as ProviderId[]);

for (const prefer of providers) {
  const started = Date.now();
  let marks: Mark[];
  try {
    const provider = { prefer, fallback: false, retries: 0 };
    marks = await thoughtMarks(words, { pieceWords, provider });
    if (args.includes("--width") && box) {
      // the app's second step: split points for lines wider than the box
      const thoughtSeconds = (Date.now() - started) / 1000;
      const long = longThoughts(words, marks, box[0]);
      const splits = await splitPoints(
        long.map(([a, b]) => words.slice(a, b).map((w) => w.text)),
        box[0],
        { provider },
      );
      marks = [...marks];
      long.forEach(([a, b], k) => {
        for (let i = a + 1; i < b; i++) marks[i] = 0;
        for (const s of splits[k]) marks[a + s] = 1;
      });
      console.log(`(thoughts ${thoughtSeconds.toFixed(1)} s, then split points for ${long.length} long lines)`);
    }
  } catch (e) {
    console.log(`\n== ${prefer}: failed — ${e instanceof Error ? e.message : e}`);
    continue;
  }
  const seconds = (Date.now() - started) / 1000;
  if (savePath) writeFileSync(savePath.replace(".json", `.${prefer}.json`), JSON.stringify(marks));
  const got = new Set<number>();
  for (let i = heldOut + 1; i < words.length; i++) if (marks[i] === 2) got.add(i);
  const want = new Set([...referenceStarts].filter((i) => i > heldOut));
  const hit = [...got].filter((i) => want.has(i)).length;
  const precision = got.size ? hit / got.size : 0;
  const recall = want.size ? hit / want.size : 0;
  const lines = linesFrom(marks, heldOut);
  const exact = lines.filter((l) => reference.includes(l)).length;
  console.log(
    `\n== ${prefer}, ${pieceWords === Infinity ? "one request" : `pieces of ~${pieceWords} words`}: ${seconds.toFixed(1)} s`,
  );
  console.log(
    `line breaks: ${(precision * 100).toFixed(0)}% of its breaks are in the reference, ` +
      `${(recall * 100).toFixed(0)}% of the reference breaks found; ` +
      `${exact}/${reference.length} lines exactly as the reference`,
  );
  console.log(lines.map((l) => (reference.includes(l) ? "   " : " ≠ ") + l).join("\n"));
  if (box) {
    // what the viewer sees: the marks laid out for one box size
    const [maxChars, maxLines] = box;
    const timed = words.map((w, id) => ({ id, text: w.text, start: w.start, end: w.end, cut: marks[id] }));
    const cues = layoutCues(timed.slice(heldOut), { maxChars, maxLines });
    console.log(
      `\n-- on screen in a ${maxChars}×${maxLines} box (${unplannedBreaks(cues)} lines broken where the match marked nothing) --`,
    );
    for (const c of cues) {
      const shown = sliceLines(c.words, cueLineCounts(c, maxChars));
      console.log("  " + shown.map((l) => l.map((w) => w.text).join(" ")).join(" / "));
    }
  }
}
