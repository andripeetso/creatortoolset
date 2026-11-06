import { jsonObject } from "./plans";
import type { EditOp } from "./doc";
import type { AuditClaim, AuditResult, AuditVerdict, Document } from "./types";

/**
 * The accuracy audit: what goes to the research model, and how its answer
 * becomes a list of claims with verdicts, evidence, sources and a fix.
 * Pure — the network call lives in api/lib/research.
 */

export const MAX_AUDIT_CHARS = 24_000;
export const MAX_AUDIT_CLAIMS = 25;

// The audit flags claims a viewer could look up and find false. It never rewords slides into study language, which would destroy the content.
export const AUDIT_SYSTEM = `You check a creator's short-form social post (a reel script, a carousel slide by slide, or ad copy) against primary sources on the web, so they never post something false. These are popular videos and carousels, not science writing: a slide has a few words, so it states a finding plainly and boldly, and the post description is where the creator backs it up — who found it, how solid it is, the caveats. A slide that simplifies, rounds, or leaves the caveats for the description is doing its job. What the creator needs from you is the claims a viewer could look up and find false: the opposite result, a different group or subject than the study had, a number or study that doesn't exist.

1. List the checkable claims: numbers, named studies, researchers, institutions, dates, causal claims, quotes, "research shows". Skip opinions and calls to action.
2. For each, find the primary source (the study, the institution's own page, official data) and decide:
   supported: what the source found, said plainly, simplified or rounded included;
   partly: true, but the source is narrower in a way worth a line in the description;
   contradicted: false as stated, including a finding moved to a subject the source didn't study;
   unverifiable: no source found either way.
3. Explain each verdict in at most two sentences, naming the source; for partly, that is the line the description could carry. Give "fix" only for contradicted: the shortest true wording, as bold and as short as the original, in the creator's voice. Copy "claim" verbatim from the marked block — the app replaces those words with "fix". "where" is that block's id (b3, h1, caption, pinned) or "slide 2" for a source post.
4. Score the piece 0–100 (100 = nothing a viewer could look up and find false) and write a two-sentence summary: what would be false as posted, and what the description should carry.

Return ONLY a JSON object: {"score": number, "summary": string, "claims": [{"id": "c1", "where": "b3" | "h1" | "caption" | "pinned" | "slide 2" | "", "claim": string, "verdict": "supported"|"partly"|"contradicted"|"unverifiable", "confidence": 0-1, "evidence": string, "sources": [{"title": string, "url": string}], "fix": string | null}]}`;

/** Answering one research question for a creator: sourced, specific, honest about strength of evidence. */
export const RESEARCH_QUESTION_SYSTEM = `You are a research assistant for a content creator. Answer the question with specific, sourced facts: numbers, dates, who found what, and how strong the evidence is (study type, sample size, how often it has been replicated). Cite sources inline as [n]. At most 250 words. When the evidence is thin, mixed or about a narrower group than the question implies, say so plainly instead of rounding up.`;

/** Claude on the Mac searches the web itself (WebSearch, WebFetch): how far, and how its sources come back. */
export const MAC_RESEARCH = {
  quick: "\n\nSearch the web for this before you answer, quickly: at most three searches, the primary source first; open a page only when the search results don't settle it.",
  deep: "\n\nResearch this properly on the web: search widely, open and read the primary sources (the study, the institution's own page, official data), not write-ups of them.",
  sources: "\n\nAfter the answer write a line \"Sources:\" and under it one line per source you cited: [n] URL",
};

/** A research answer ending in "Sources:" and "[n] URL" lines → the answer, and the URLs in [n] order. */
export function splitSources(text: string): { content: string; citations: string[] } {
  const at = text.search(/\n\s*(?:#+\s*|\*\*)?Sources:?(?:\*\*)?\s*\n/i);
  if (at < 0) return { content: text.trim(), citations: [] };
  const citations: string[] = [];
  for (const m of text.slice(at).matchAll(/^\s*[-*]?\s*\[(\d+)\][^\n]*?(https?:\/\/[^\s)\]>]+)/gm)) {
    citations[Number(m[1]) - 1] = m[2]!.replace(/[.,;]+$/, "");
  }
  return { content: text.slice(0, at).trim(), citations: Array.from(citations, (u) => u ?? "") };
}

export const AUDIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    summary: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          where: { type: "string" },
          claim: { type: "string" },
          verdict: { type: "string", enum: ["supported", "partly", "contradicted", "unverifiable"] },
          confidence: { type: "number" },
          evidence: { type: "string" },
          sources: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
          fix: { type: ["string", "null"] },
        },
        required: ["claim", "verdict", "evidence"],
      },
    },
  },
  required: ["score", "summary", "claims"],
};

/**
 * A document as the audit reads it: block ids first, so verdicts can point back.
 * Past MAX_AUDIT_CHARS the text is cut, says how much of the piece it kept, and
 * `covered` carries the same numbers to the audit result.
 */
export function documentAudit(doc: Pick<Document, "title" | "kind" | "blocks" | "hooks" | "caption" | "pinned">): { text: string; covered?: { chars: number; total: number } } {
  const body = [
    ...(doc.hooks ?? []).map((h) => `[${h.id}] ${h.text}`),
    ...doc.blocks.map((b) => `[${b.id}] ${b.text}`),
    ...(doc.caption ? [`[caption] ${doc.caption.text}`] : []),
    ...(doc.pinned ? [`[pinned] ${doc.pinned.text}`] : []),
  ].join("\n\n");
  const full = `Piece: "${doc.title}" (${doc.kind}). Each block is marked with its id; use it as "where".\n\n${body}`;
  if (full.length <= MAX_AUDIT_CHARS) return { text: full };
  const total = full.length;
  const note = `The audit read the first ${MAX_AUDIT_CHARS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters of this piece; the rest was not checked.`;
  return { text: `${full.slice(0, MAX_AUDIT_CHARS)}\n\n[${note}]`, covered: { chars: MAX_AUDIT_CHARS, total } };
}

/** A source post as the audit reads it: the pack without comments. */
export function postAuditText(handle: string, kind: string, markdown: string): string {
  return `Piece: an Instagram ${kind} by @${handle}. Refer to slides as "slide N" in "where".\n\n${markdown}`.slice(0, MAX_AUDIT_CHARS);
}

const VERDICTS = new Set<AuditVerdict>(["supported", "partly", "contradicted", "unverifiable"]);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Strict enough to trust, lenient enough to survive a model's habits. Throws when there is nothing usable. */
export function parseAuditResult(content: string, citations: string[] = []): AuditResult {
  const o = jsonObject(content);
  const rawClaims = Array.isArray(o.claims) ? o.claims : [];
  const claims: AuditClaim[] = [];
  for (const [i, raw] of rawClaims.entries()) {
    if (!isRec(raw)) continue;
    const claim = str(raw.claim, 600);
    const verdictRaw = str(raw.verdict, 20).toLowerCase() as AuditVerdict;
    if (!claim || !VERDICTS.has(verdictRaw)) continue;
    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
      .flatMap((s) => {
        if (typeof s === "string") return /^https?:\/\//.test(s) ? [{ url: s.slice(0, 500) }] : [];
        if (!isRec(s)) return [];
        const url = str(s.url, 500);
        return /^https?:\/\//.test(url) ? [{ url, title: str(s.title, 200) || undefined }] : [];
      })
      .slice(0, 6);
    // "[2]" style references point into the citation list
    for (const m of str(raw.evidence, 1200).matchAll(/\[(\d{1,2})\]/g)) {
      const url = citations[Number(m[1]) - 1];
      if (url && !sources.some((s) => s.url === url)) sources.push({ url });
    }
    const fix = str(raw.fix, 1200);
    claims.push({
      id: str(raw.id, 12) || `c${i + 1}`,
      where: str(raw.where, 40) || undefined,
      claim,
      verdict: verdictRaw,
      confidence: num(raw.confidence, 0, 1, 0.5),
      evidence: str(raw.evidence, 1200),
      sources: sources.slice(0, 6),
      fix: fix || undefined,
    });
    if (claims.length >= MAX_AUDIT_CLAIMS) break;
  }
  const summary = str(o.summary, 1500);
  if (!claims.length && !summary) throw new Error("The research model returned no claims and no summary");
  const counted = countVerdicts(claims);
  const score = num(o.score, 0, 100, scoreFrom(counted));
  return { score: Math.round(score), summary, claims, citations: citations.slice(0, 40) };
}

export function countVerdicts(claims: AuditClaim[]): Record<AuditVerdict, number> {
  const c: Record<AuditVerdict, number> = { supported: 0, partly: 0, contradicted: 0, unverifiable: 0 };
  for (const x of claims) c[x.verdict]++;
  return c;
}

/** Fallback score when the model gives none: supported 1, partly 0.5, unverifiable 0.25, contradicted 0. */
function scoreFrom(c: Record<AuditVerdict, number>): number {
  const n = c.supported + c.partly + c.contradicted + c.unverifiable;
  return n ? ((c.supported + 0.5 * c.partly + 0.25 * c.unverifiable) / n) * 100 : 100;
}

const FIX_WHERE = /^(b\d{1,5}|h\d{1,5}|caption|pinned)$/;
const NUM: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

function fold(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function foldIndex(s: string): { folded: string; at: number[] } {
  let folded = "";
  const at: number[] = [];
  let space = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      if (!space && folded) {
        folded += " ";
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    if (/[\u2018\u2019\u201A\u201B]/.test(c)) {
      folded += "'";
      at.push(i);
    } else if (/[\u201C\u201D\u201E\u201F]/.test(c)) {
      folded += '"';
      at.push(i);
    } else if (/[\u2010-\u2015]/.test(c)) {
      folded += "-";
      at.push(i);
    } else if (c === "\u2026") {
      folded += "...";
      at.push(i, i, i);
    } else {
      folded += c;
      at.push(i);
    }
  }
  return { folded, at };
}

function words(s: string): string[] {
  return (fold(s).toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? []).map((w) => NUM[w] ?? w);
}

function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(?:\n\s*\n+)|(?<=[.!?])["']?\s+(?=[A-Z0-9\u201C"])/g;
  let start = 0;
  let m: RegExpExecArray | null;
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    if (to > from) spans.push([from, to]);
  };
  while ((m = re.exec(text))) {
    push(start, m.index);
    start = m.index + m[0].length;
  }
  push(start, text.length);
  return spans;
}

function locateClaim(text: string, claim: string): [number, number] | null {
  if (!claim || !text) return null;
  const exact = text.indexOf(claim);
  if (exact >= 0) return [exact, exact + claim.length];
  const ci = text.toLowerCase().indexOf(claim.toLowerCase());
  if (ci >= 0) return [ci, ci + claim.length];
  const hay = foldIndex(text);
  const needle = fold(claim);
  if (needle) {
    const fi = hay.folded.toLowerCase().indexOf(needle.toLowerCase());
    if (fi >= 0) {
      const last = hay.at[fi + needle.length - 1];
      const first = hay.at[fi];
      if (first !== undefined && last !== undefined) return [first, last + 1];
    }
  }
  const need = [...new Set(words(claim))];
  if (need.length < 4) return null;
  const sents = sentenceSpans(text);
  let best: { a: number; b: number; score: number } | null = null;
  for (let i = 0; i < sents.length; i++) {
    const seen = new Set<string>();
    let n = 0;
    for (let j = i; j < sents.length && j < i + 3; j++) {
      const [a, b] = sents[j]!;
      n += words(text.slice(a, b)).length;
      for (const w of words(text.slice(a, b))) seen.add(w);
      let hit = 0;
      for (const w of need) if (seen.has(w)) hit++;
      const recall = hit / need.length;
      if (recall < 0.7 || n > Math.max(need.length * 3, 80)) continue;
      const span: [number, number] = [sents[i]![0], sents[j]![1]];
      if (span[1] - span[0] > text.length * 0.45 && claim.length < text.length * 0.3) continue;
      const score = recall - (j - i) * 0.05;
      if (!best || score > best.score) best = { a: span[0], b: span[1], score };
    }
  }
  return best ? [best.a, best.b] : null;
}

/** Replace the claim's span with the fix. Null if that wording is not in the field. */
export function applyAuditWording(text: string, claim: string, fix: string): string | null {
  const span = locateClaim(text, claim.trim());
  if (!span) return null;
  if (text.slice(span[0], span[1]) === fix) return null;
  return `${text.slice(0, span[0])}${fix}${text.slice(span[1])}`;
}

function fieldText(doc: Pick<Document, "blocks" | "hooks" | "caption" | "pinned">, where: string): string | undefined {
  if (where === "caption") return doc.caption?.text;
  if (where === "pinned") return doc.pinned?.text;
  if (where.startsWith("h")) return doc.hooks?.find((h) => h.id === where)?.text;
  return doc.blocks.find((b) => b.id === where)?.text;
}

/**
 * Surgical edits for accepted audit fixes. Several claims can land in one
 * reel page or caption — each replaces only its own span, never the whole field.
 */
export function auditEdits(
  doc: Pick<Document, "blocks" | "hooks" | "caption" | "pinned">,
  claims: Array<Pick<AuditClaim, "id" | "where" | "claim" | "fix">>,
): { ops: EditOp[]; appliedIds: string[] } {
  const byWhere = new Map<string, typeof claims>();
  for (const c of claims) {
    if (!c.fix || !c.where || !FIX_WHERE.test(c.where)) continue;
    const list = byWhere.get(c.where) ?? [];
    list.push(c);
    byWhere.set(c.where, list);
  }
  const ops: EditOp[] = [];
  const appliedIds: string[] = [];
  for (const [where, list] of byWhere) {
    const current = fieldText(doc, where);
    if (current == null) continue;
    let text = current;
    for (const c of list) {
      const next = applyAuditWording(text, c.claim, c.fix!);
      if (next == null) continue;
      text = next;
      appliedIds.push(c.id);
    }
    if (text === current) continue;
    ops.push(where === "caption" ? { op: "set_caption", text } : where === "pinned" ? { op: "set_pinned", text } : { op: "replace", id: where, text });
  }
  return { ops, appliedIds };
}

/** One paragraph the chat (and the co-writing model, through history) can read. */
export function auditSummaryText(title: string, r: AuditResult): string {
  const c = countVerdicts(r.claims);
  const head = `Accuracy audit of “${title}”: ${r.score}/100 — ${c.supported} supported, ${c.partly} partly, ${c.contradicted} contradicted, ${c.unverifiable} unverifiable.`;
  const part = r.covered ? `Only the first ${r.covered.chars.toLocaleString("en-US")} of ${r.covered.total.toLocaleString("en-US")} characters of the piece were checked.` : "";
  const lines = r.claims
    .filter((x) => x.verdict !== "supported")
    .map((x) => `- ${x.where ? `${x.where}: ` : ""}${x.claim} — ${x.verdict}. ${x.evidence}${x.fix ? ` Fix: ${x.fix}` : ""}`);
  return [head, r.summary, part, ...lines].filter(Boolean).join("\n");
}
