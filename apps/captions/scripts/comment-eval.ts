/**
 * Run the Jev comment judge on a sample of real comments and write a
 * sheet to check by hand.
 *
 *   npx tsx scripts/comment-eval.ts [accountId] [--n 100] [--out comments-sheet.tsv]
 *
 * Reads the account's saved Graph comments (DATA_DIR or ~/.caption-studio),
 * picks a fixed pseudo-random sample across posts, and prints how the
 * comments rank. The sheet has an empty "you" column: fill in keep/hide
 * and question yes/no to measure where the thresholds should sit.
 */
import "dotenv/config";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { judgeComments } from "../api/lib/instagram/comment-judge";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const n = Number(option("--n") ?? 100);
const out = option("--out") ?? "comments-sheet.tsv";
const dataDir = process.env.DATA_DIR || path.join(homedir(), ".caption-studio");
const accountsDir = path.join(dataDir, "instagram", "accounts");
const accountId =
  args.find((a) => !a.startsWith("--") && a !== option("--n") && a !== option("--out")) ??
  readdirSync(accountsDir).find((d) => existsSync(path.join(accountsDir, d, "graph-comments.json")));
if (!accountId) throw new Error("No account with saved Graph comments");

type Saved = { id: string; text: string; likeCount: number; replies?: Saved[] };
const byPost = JSON.parse(
  readFileSync(path.join(accountsDir, accountId, "graph-comments.json"), "utf8"),
) as Record<string, Saved[]>;
const catalog = (() => {
  try {
    const raw = JSON.parse(readFileSync(path.join(accountsDir, accountId, "catalog.json"), "utf8"));
    const items: { shortcode: string; captionPreview?: string; caption?: string }[] =
      Array.isArray(raw) ? raw : (raw.items ?? []);
    return new Map(items.map((i) => [i.shortcode, i.caption ?? i.captionPreview ?? ""]));
  } catch {
    return new Map<string, string>();
  }
})();

// fixed pseudo-random sample so reruns score the same comments
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pool = Object.entries(byPost).flatMap(([shortcode, list]) =>
  list.filter((c) => c.text.trim()).map((c) => ({ shortcode, c })),
);
const sample = pool
  .map((p) => ({ p, r: rand() }))
  .sort((a, b) => a.r - b.r)
  .slice(0, n)
  .map((x) => x.p);

const started = Date.now();
const rows: { shortcode: string; c: Saved; kind: string; worth: number; needsAnswer: number }[] = [];
const posts = new Map<string, Saved[]>();
for (const s of sample) posts.set(s.shortcode, [...(posts.get(s.shortcode) ?? []), s.c]);
let requests = 0;
await Promise.all(
  [...posts].map(async ([shortcode, list]) => {
    const judged = await judgeComments({ caption: catalog.get(shortcode) }, list);
    requests += Math.ceil(list.length / 20);
    for (const c of list) {
      const j = judged.get(c.id);
      if (j) rows.push({ shortcode, c, ...j });
    }
  }),
);
const seconds = (Date.now() - started) / 1000;

rows.sort((a, b) => b.worth - a.worth);
const clean = (t: string) => t.replace(/\s+/g, " ").trim();
writeFileSync(
  out,
  ["worth\tquestion\tkind\tlikes\tpost\tcomment\tyou (keep/hide, question y/n)"]
    .concat(
      rows.map((r) =>
        [r.worth.toFixed(2), r.needsAnswer.toFixed(2), r.kind, r.c.likeCount, r.shortcode, clean(r.c.text), ""].join("\t"),
      ),
    )
    .join("\n") + "\n",
);

console.log(`${rows.length} comments from ${posts.size} posts, ${requests} Jev requests, ${seconds.toFixed(1)} s → ${out}\n`);
const show = (label: string, list: typeof rows) => {
  console.log(`-- ${label}`);
  for (const r of list) {
    console.log(`  ${r.worth.toFixed(2)}  q${r.needsAnswer.toFixed(2)}  ${r.kind.padEnd(8)} ${clean(r.c.text).slice(0, 110)}`);
  }
};
show("highest value", rows.slice(0, 12));
show("lowest value", rows.slice(-12));
show(
  "top questions to answer",
  [...rows].sort((a, b) => b.needsAnswer - a.needsAnswer).slice(0, 10),
);
