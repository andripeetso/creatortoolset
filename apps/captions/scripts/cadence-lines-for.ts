/**
 * Caption Studio's own line pass for words timed elsewhere (a render's
 * captions use it so their lines break the way Caption Studio's do):
 * Match cadence thoughts, split points for thoughts wider than the box, then
 * layoutCues, exactly the steps POST /api/captions/auto runs.
 *
 *   npx tsx scripts/cadence-lines-for.ts words.json out.json [--box 26x1] [--env path/.env] [--provider anthropic]
 *
 * words.json = [{t|text, s|start, e|end}]; out.json = [{start, end, words: [{t, s, e}]}], one per caption.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ProviderId } from "../api/ai-complete";
import { longThoughts, splitPoints, thoughtMarks, type Mark } from "../api/lib/cadence-lines";
import { layoutCues } from "../src/lib/captions";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const env = option("--env");
if (env) process.loadEnvFile(env);
const [maxChars, maxLines] = (option("--box") ?? "26x1").split("x").map(Number);
const provider = { prefer: (option("--provider") ?? "anthropic") as ProviderId };
const [inPath, outPath] = args.filter((a) => !a.startsWith("--") && ![env, option("--box"), option("--provider")].includes(a));

const raw = JSON.parse(readFileSync(inPath, "utf8")) as Record<string, unknown>[];
const words = raw.map((w, id) => ({
  id,
  text: String(w.t ?? w.text),
  start: Number(w.s ?? w.start),
  end: Number(w.e ?? w.end),
}));

let marks: Mark[] = await thoughtMarks(words, { provider });
const long = longThoughts(words, marks, maxChars);
const splits = await splitPoints(long.map(([a, b]) => words.slice(a, b).map((w) => w.text)), maxChars, { provider });
marks = [...marks];
long.forEach(([a, b], k) => {
  for (let i = a + 1; i < b; i++) marks[i] = 0;
  for (const s of splits[k]) marks[a + s] = 1;
});

const cues = layoutCues(words.map((w, i) => ({ ...w, cut: marks[i] })), { maxChars, maxLines });
writeFileSync(
  outPath,
  JSON.stringify(
    cues.map((c) => ({ start: c.start, end: c.end, words: c.words.map((w) => ({ t: w.text, s: w.start, e: w.end })) })),
    null,
    1,
  ),
);
console.log(`${cues.length} captions, ${long.length} thoughts split for a ${maxChars}x${maxLines} box`);
