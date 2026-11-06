/**
 * Content Workshop eval: the writer on real cases, graded by code only.
 *
 *   npx tsx scripts/workshop-eval.ts --dry-run [--owner admin] [--cases 6]
 *   WORKSHOP_EVAL_COOKIE='cap_auth=…' npx tsx scripts/workshop-eval.ts
 *     [--server https://creatortoolset.com] [--samples 2] [--case <id>]
 *     [--timeout-min 20] [--out eval-out.json] [--baseline eval-old.json]
 *
 * Cases come from the author's kept rewrites (DATA_DIR/workshop/users/<owner>.edits.json,
 * read only): the AI's text the owner later rewrote is the piece, and the turn asks
 * the writer to take another pass. Control turns only answer (a caption request, a
 * question): no block may change. Every turn goes through the live Workshop API of
 * --server, so it runs the real runTurn, the real buildTurnPrompt and the Mac relay
 * (Claude on the author's subscription, Opus 5.5 at xhigh, no web). An admin's turn
 * falls back to the API key only when the Mac misses; the provider is printed so a
 * fallback shows. The cookie is the signed-in admin's, copied from the browser; the
 * eval makes its own sessions and deletes them.
 *
 * --dry-run builds every case's prompt locally with buildTurnPrompt and prints
 * the sizes, without a server or a model. It leaves out the folder the Mac reads
 * (posts, sources, sessions), so it measures the packed prompt only.
 *
 * Grades, mechanical only: a rewrite sample passes when readThrough finds no more
 * repeated openings, clipped runs or repeated phrases than the input had; a
 * control passes when no block changed. A case fails at half or more failed
 * samples. Tokens and API-equivalent cost are printed from the reply's usage
 * (the Mac reports them; the API path reports none yet).
 *
 * A failing grade is never fixed by adding prompt text. Find out what the writer
 * did with the rewrite history and the folder first; a rule written to pass the
 * grader is the bloat that is rejected (words stay the author's).
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askedOnlyForCaption } from "../api/lib/workshop/chat-plans";
import { buildTurnPrompt } from "../api/lib/workshop/chat-prompt";
import { blocksFromMarkdown, newDocument } from "../api/lib/workshop/doc";
import type { EditPair } from "../api/lib/workshop/edit-log";
import { readThrough } from "../api/lib/workshop/readthrough";
import type { DocKind } from "../api/lib/workshop/types";

export interface EvalCase {
  id: string;
  kind: DocKind;
  title: string;
  /** The piece as the AI wrote it (blank lines split the blocks). */
  text: string;
  message: string;
  /** Control: the turn should only answer, so no block may change. */
  control: boolean;
  /** The message asks only for the post description (chat-plans askedOnlyForCaption). */
  captionOnly?: boolean;
}

export interface SampleResult {
  ok: boolean;
  status: string;
  provider?: string;
  readThroughBefore: number;
  readThroughAfter: number;
  changedBlocks: number;
  tokens?: number;
  costUsd?: number;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = process.env.DATA_DIR || path.join(homedir(), ".caption-studio");
const owner = option("--owner") ?? process.env.ADMIN_USERNAME ?? "admin";
const nCases = Number(option("--cases") ?? 6);
const samples = Number(option("--samples") ?? 2);
const only = option("--case");
const server = (option("--server") ?? "http://localhost:3000").replace(/\/$/, "");
const timeoutMs = Number(option("--timeout-min") ?? 20) * 60_000;

export const isRewrite = (p: EditPair) => p.kind === "slide" || p.kind === "script" || p.kind === "hook";

/** One kept rewrite as a case: the AI's text is the piece, the turn asks for another pass. */
export const rewriteCase = (p: EditPair): EvalCase => ({
  id: `rewrite-${p.key.slice(0, 40).replace(/[^a-z0-9]+/gi, "-")}`,
  kind: p.docKind === "notes" ? "free" : p.docKind,
  title: p.docTitle,
  text: p.from,
  message: "Take another pass at this piece.",
  control: false,
});

/** The newest kept rewrites of the AI's text, as eval cases, plus two turns that should only answer. */
export function casesFrom(pairs: EditPair[], n: number): EvalCase[] {
  const rewrites = pairs.filter(isRewrite).slice(-n).reverse();
  const cases = rewrites.map(rewriteCase);
  const base = rewrites[0];
  if (base) {
    const captionMessage = "Write the post description.";
    cases.push(
      { id: "control-caption", kind: base.docKind, title: base.docTitle, text: base.from, message: captionMessage, control: true, captionOnly: askedOnlyForCaption(captionMessage) },
      { id: "control-question", kind: base.docKind, title: base.docTitle, text: base.from, message: "Which part is weakest, and why? Don't change anything.", control: true },
    );
  }
  return cases;
}

/** The prompt the server would build for this case, from the same inputs (no folder). */
export function dryPrompt(c: EvalCase) {
  const doc = newDocument("eval-doc", "eval-session", c.kind, c.title, { text: c.text, author: "ai", now: 0 });
  return buildTurnPrompt({ doc, frameworks: [], rules: [], pinned: [], sources: [], history: [], message: c.message });
}

async function call(method: string, route: string, cookie: string, body?: unknown): Promise<any> {
  const res = await fetch(`${server}/api/workshop${route}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const asBlocks = (texts: string[]) => texts.map((text, i) => ({ id: `b${i + 1}`, text, author: "ai" as const, at: 0 }));

export interface LiveTurn {
  msg: any;
  before: string[];
  after: string[];
}

/** One turn on the live server, in a throwaway session that is deleted afterwards. */
export async function liveTurn(c: EvalCase, cookie: string): Promise<LiveTurn> {
  const session = await call("POST", "/sessions", cookie, { title: `[eval] ${c.id} ${new Date().toISOString()}` });
  try {
    const doc = await call("POST", `/sessions/${session.id}/docs`, cookie, { kind: c.kind, title: c.title, text: c.text });
    const { reply } = await call("POST", `/sessions/${session.id}/chat`, cookie, { docId: doc.id, text: c.message });
    const until = Date.now() + timeoutMs;
    let msg: any;
    while (Date.now() < until) {
      const chat: any[] = await call("GET", `/sessions/${session.id}/chat`, cookie);
      msg = chat.find((m) => m.id === reply.id);
      if (msg && msg.status !== "thinking") break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const after = await call("GET", `/sessions/${session.id}/docs/${doc.id}`, cookie);
    return { msg, before: blocksFromMarkdown(c.text), after: (after.blocks as Array<{ text: string }>).map((b) => b.text) };
  } finally {
    await call("DELETE", `/sessions/${session.id}`, cookie).catch(() => {});
  }
}

export async function liveSample(c: EvalCase, cookie: string): Promise<SampleResult> {
  const { msg, before, after } = await liveTurn(c, cookie);
  const changed = (msg?.edits?.blockIds ?? []).length;
  const before0 = readThrough({ kind: c.kind, blocks: asBlocks(before) }).length;
  const after0 = readThrough({ kind: c.kind, blocks: asBlocks(after) }).length;
  const ok = msg?.status === "done" && (c.control
    ? changed === 0 && after.join("\n\n") === before.join("\n\n")
    : after0 <= before0);
  return {
    ok,
    status: msg?.status ?? "timeout",
    provider: msg?.provider,
    readThroughBefore: before0,
    readThroughAfter: after0,
    changedBlocks: changed,
    tokens: msg?.usage?.tokens,
    costUsd: msg?.usage?.costUsd,
  };
}

async function main() {
  const pairs = JSON.parse(readFileSync(path.join(dataDir, "workshop", "users", `${owner}.edits.json`), "utf8")) as EditPair[];
  const all = casesFrom(pairs, nCases);
  const cases = all.filter((c) => !only || c.id === only);
  if (!cases.length) throw new Error(`No case${only ? ` named ${only}` : ""} in ${owner}'s kept rewrites`);

  if (flag("--dry-run")) {
    for (const c of cases) {
      const p = dryPrompt(c);
      console.log(`${c.id}\t${c.kind}\t${c.control ? "control" : "rewrite"}\tsystem ${Buffer.byteLength(p.system)} B\tuser ${Buffer.byteLength(p.user)} B${c.captionOnly !== undefined ? `\tcaptionOnly ${c.captionOnly}` : ""}`);
    }
    return;
  }

  const cookie = process.env.WORKSHOP_EVAL_COOKIE;
  if (!cookie) throw new Error("Set WORKSHOP_EVAL_COOKIE to the signed-in admin's Cookie header (or use --dry-run)");
  const report: Array<{ id: string; control: boolean; passRate: number; samples: SampleResult[] }> = [];
  for (const c of cases) {
    const results: SampleResult[] = [];
    for (let i = 0; i < samples; i++) {
      const r = await liveSample(c, cookie);
      results.push(r);
      console.log(`${c.id} #${i + 1}: ${r.ok ? "pass" : "FAIL"} (${r.status}${r.provider ? `, ${r.provider}` : ""}) readThrough ${r.readThroughBefore}→${r.readThroughAfter}, changed ${r.changedBlocks}`);
    }
    const passRate = results.filter((r) => r.ok).length / results.length;
    report.push({ id: c.id, control: c.control, passRate, samples: results });
  }

  const baseline = option("--baseline")
    ? (JSON.parse(readFileSync(option("--baseline")!, "utf8")) as { cases: Array<{ id: string; passRate: number }> })
    : undefined;
  console.log("\ncase\tpass\tvs baseline");
  for (const r of report) {
    const was = baseline?.cases.find((b) => b.id === r.id);
    const delta = was ? `${(r.passRate - was.passRate) >= 0 ? "+" : ""}${Math.round((r.passRate - was.passRate) * 100)} pts` : "";
    console.log(`${r.id}\t${Math.round(r.passRate * 100)}%\t${delta}`);
  }
  const all2 = report.flatMap((r) => r.samples);
  const tokens = all2.reduce((n, s) => n + (s.tokens ?? 0), 0);
  const cost = all2.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  console.log(`\ntokens ${tokens.toLocaleString()} · API-equivalent $${cost.toFixed(2)} (Mac usage only)`);
  const out = option("--out");
  if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), server, samples, cases: report }, null, 2));
}

// the helpers above are importable; the run is only when started directly
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
