import type { DraftKind, Framework, FrameworkRole, KnowledgeFile, Project } from "./types";
import type { AccountContext } from "../instagram/types";
import { effectiveSavedFor } from "../instagram/research";

export interface PromptPack {
  handle: string;
  kind: string;
  url: string;
  markdown: string;
  note?: string;
  /** Why the author kept this source. */
  savedFor?: Array<"content" | "format">;
}

export interface PromptInput {
  kind: DraftKind;
  project?: Pick<Project, "name" | "audience" | "voice" | "cta" | "notes" | "knowledge">;
  /** Live Analyzer snapshot of the brand/author Instagram account. */
  account?: AccountContext | null;
  /** One narrative shape sets the order; a persuasion and an argument framework must have every step present inside it. */
  frameworks?: Array<Pick<Framework, "name" | "role" | "summary" | "steps" | "whenToUse" | "example">>;
  notes: string;
  prompt: string;
  packs: PromptPack[];
  /** Writing rules that apply to this piece, in the author's words. */
  rules?: string[];
}

export const NOTES_MAX = 8000;
/** Always-on project instructions (audience, voice, CTA, notes) — keep this small. */
export const INSTRUCTIONS_MAX = 20_000;
export const CONTEXT_BLURB = 80;
export const CONTEXT_EXCERPT = 240;
export const GENERATE_CONTEXT_MAX = 2000;
// The API-key fallback loads context files whole; on the Mac they are files in the folder.
export const CONTEXT_FILE_MAX = 80_000;
export const CONTEXT_FETCH_MAX = 160_000;
export const CONTEXT_FETCH_FILES = 24;

const SYSTEM_BASE = `You write scripts, slides and copy with the author, from their research, in English.
Rules:
- Return exactly one JSON object and nothing else: no prose before or after, no markdown fence.
- When a framework is given, follow its steps in order and make that structure visible in the piece.
- Use the sources for facts, angles, objections and the audience's own words (the comments show what people actually ask and push back on). Do not copy sentences from the sources. Do not invent numbers, studies or quotes.
- Sources kept for format are layout examples: steal the structure, pacing, slide map and hook device. Do not use that source's topic, claims, examples or wording. Sources kept for content (or unmarked) are for facts, angles and the audience's language. A source can be both.
- Write in the project's voice, for the project's audience, and end on the project's call to action unless the brief says otherwise.
- Project instructions are short and always-on. Context files are listed, not loaded — fetch K1 (or the file name) when you need one. Do not dump them into the piece.
- Sources from the author's own Instagram handle are their scripts: remake them, keep their voice.
- The brief overrides everything else.
- Weigh the sources by where the words come from: on-screen slide text and the spoken transcript are the creator's own words and carry the most weight; the caption is secondary; comments are audience reaction — use them for objections and the audience's language, never as facts.`;

const KIND_SPEC: Record<DraftKind, string> = {
  reel: `Deliverable: a talking-to-camera reel script.
Return: {"title": string, "hook": {"spoken": string, "onScreen": string}, "beats": [{"label": string, "spoken": string, "onScreen": string, "visual": string, "seconds": number}], "cta": string, "caption": string, "hashtags": [string], "whyItWorks": [string]}
- 30–60 seconds spoken in total (about 80–160 words across hook, beats and cta).
- 3–7 beats. "label" names the framework step the beat delivers (or a short beat name if no framework).
- "spoken" is the words said to camera.
- "onScreen" is the text overlay for that moment, 8 words or fewer. "visual" is a one-line shot note.
- "hook" is the first 3 seconds: spoken line plus the on-screen text.
- "caption" is the post caption (first line is a hook, then value, then the CTA). "hashtags" without the # sign, 5–15.
- "whyItWorks": 2–4 short bullets on the choices made and what in the sources they came from.`,
  carousel: `Deliverable: an Instagram carousel.
Return: {"title": string, "slides": [{"n": number, "headline": string, "body": string, "visual": string}], "caption": string, "hashtags": [string], "whyItWorks": [string]}
- 6–10 slides. Slide 1 is the hook: a headline only, body empty. The last slide is the call to action.
- One idea per slide. "headline" 10 words or fewer; "body" 40 words or fewer; "visual" a one-line design note.
- "caption" repeats the promise and the CTA. "hashtags" without the # sign, 5–15.
- "whyItWorks": 2–4 short bullets.`,
  ad: `Deliverable: paid social ad copy.
Return: {"title": string, "variants": [{"angle": string, "hook": string, "primaryText": string, "headline": string, "description": string, "cta": string}], "whyItWorks": [string]}
- Exactly 3 variants, each with a clearly different angle (for example: pain, proof, curiosity).
- "hook" is the first line of the primary text. "primaryText" 60–150 words, answering the objections seen in the comments. "headline" 40 characters or fewer. "description" 30 characters or fewer. "cta" a button label.
- "whyItWorks": 2–4 short bullets.`,
  free: `Deliverable: whatever the brief asks for.
Return: {"title": string, "markdown": string}
- "markdown" holds the whole piece, formatted with ## headings and lists where they help. Do not put the title inside "markdown".`,
};

const DELIVERABLE: Record<DraftKind, string> = {
  reel: "A reel script for this project.",
  carousel: "A carousel for this project.",
  ad: "Ad copy for this project.",
  free: "Follow the brief.",
};

function keptForLine(savedFor?: Array<"content" | "format">): string {
  const tags = effectiveSavedFor(savedFor);
  const content = tags.includes("content");
  const format = tags.includes("format");
  if (format && content) return "Kept for content and format — use the topic and steal the layout.";
  if (format) return "Kept for format only — steal the structure, pacing, slide map and hook device. Do not use its topic, claims, examples or wording.";
  return "Kept for content — facts, angles and the audience's language.";
}

export function knowledgeBlurb(text: string, max = CONTEXT_BLURB): string {
  return (text.replace(/^\uFEFF/, "").trim().split(/\r?\n/, 1)[0] ?? "").slice(0, max);
}

export function knowledgeSize(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
}

/** K1 / filename / id → a context file; K1§2 → its second section alone (a book is too long to fetch whole). */
export function matchKnowledge(files: KnowledgeFile[], source: string): KnowledgeFile | undefined {
  const s = source.trim();
  const m = /^K(\d+)(?:\s*[§#]\s*(\d+))?$/i.exec(s);
  if (m) {
    const f = files[Number(m[1]) - 1];
    const sec = m[2] ? f?.sections?.[Number(m[2]) - 1] : undefined;
    if (!f || !m[2]) return f;
    if (!sec) return undefined;
    return { ...f, id: `${f.id}#${m[2]}`, name: `${f.name} §${m[2]} ${sec.title}`, text: sectionText(f.text, sec) };
  }
  const n = s.toLowerCase();
  return files.find((f) => f.id === s || f.name.toLowerCase() === n);
}

/** A section's lines (1-based, inclusive). */
export const sectionText = (text: string, sec: { from: number; to: number }): string =>
  text.split("\n").slice(Math.max(0, sec.from - 1), sec.to).join("\n");

function clipKnowledge(f: KnowledgeFile, max: number): string {
  return f.text.length <= max ? f.text : `${f.text.slice(0, max).trimEnd()}\n…[shortened]`;
}

export function clipLoadedKnowledge(files: KnowledgeFile[], maxFiles = CONTEXT_FETCH_FILES, maxChars = CONTEXT_FETCH_MAX): KnowledgeFile[] {
  const out: KnowledgeFile[] = [];
  let used = 0;
  for (const f of files) {
    if (out.length >= maxFiles) break;
    const room = maxChars - used;
    if (room <= 0) break;
    const text = f.text.slice(0, Math.min(CONTEXT_FILE_MAX, room));
    if (!text.trim()) continue;
    out.push({ ...f, text });
    used += text.length;
  }
  return out;
}

function contextIndex(files: KnowledgeFile[]): string {
  const rows = files
    .filter((f) => f.text.trim())
    .map((f) => {
      const k = files.indexOf(f) + 1;
      const blurb = f.about?.replace(/\s+/g, " ").slice(0, 300) || knowledgeBlurb(f.text);
      const head = `K${k} ${f.name} (${[f.kind, knowledgeSize(f.text.length)].filter(Boolean).join(", ")})${blurb ? ` — ${blurb}` : ""}`;
      const secs = (f.sections ?? []).map((x, j) => `  K${k}§${j + 1} ${x.title}`).join("\n");
      return secs ? `${head}\n${secs}` : head;
    });
  if (!rows.length) return "";
  return `Context files (not loaded — fetch [{"source":"K1"}], one section [{"source":"K1§2"}], or the file name when you need one; pull only what you need):\n${rows.join("\n")}`;
}

export function renderLoadedKnowledge(files: KnowledgeFile[]): string {
  if (!files.length) return "";
  return `Context loaded this turn (reference material, not a brief; do not paste it into the piece):\n${files.map((f) => `### ${f.name}\n${clipKnowledge(f, CONTEXT_FILE_MAX)}`).join("\n\n")}`;
}

function generateExcerpts(files: KnowledgeFile[]): string {
  let used = 0;
  const chunks: string[] = [];
  for (const f of files.filter((x) => x.text.trim())) {
    if (used >= GENERATE_CONTEXT_MAX) break;
    const room = Math.min(CONTEXT_EXCERPT, GENERATE_CONTEXT_MAX - used);
    if (room <= 0) break;
    const slice = f.text.slice(0, room);
    const body = f.text.length > room ? `${slice.trimEnd()}\n…[shortened]` : slice;
    chunks.push(`### ${f.name}\n${body}`);
    used += body.length;
  }
  return chunks.length ? `Context excerpts (short — fetch the rest in chat if you need the full file):\n${chunks.join("\n\n")}` : "";
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Handle only — live stats are fetched, not attached. */
export function renderAccountIndex(a: Pick<AccountContext, "username" | "fullName">): string {
  const name = a.fullName ? ` (${a.fullName})` : "";
  return `Instagram @${a.username}${name} — not loaded. Fetch [{"source":"account"}] for live followers, mix and bio.`;
}

/** Compact live snapshot of the author's (or the project's) Instagram. */
export function renderAccountContext(a: AccountContext): string {
  const stats = [
    a.followers !== undefined ? `${a.followers} followers` : "",
    a.posts !== undefined ? `${a.posts} posts` : "",
    a.postsPerWeek !== undefined ? `~${a.postsPerWeek}/wk` : "",
    a.mix ? `mix ${a.mix.reels} reels / ${a.mix.carousels} carousels / ${a.mix.posts} static` : "",
    a.lastPostedAt ? `last posted ${isoDay(a.lastPostedAt)}` : "",
    a.fetchedAt ? `profile pulled ${isoDay(a.fetchedAt)}` : "",
  ].filter(Boolean);
  const bio = a.biography?.trim() ? `\nBio: ${a.biography.trim().slice(0, 400)}` : "";
  const name = a.fullName ? ` (${a.fullName})` : "";
  return `Author's Instagram @${a.username}${name} — live snapshot of their own account. Posts from this handle in the sources are their scripts; remake those rather than treating them as someone else's research.${stats.length ? `\n${stats.join(" · ")}` : ""}${bio}`;
}

export function renderInstructions(p: Pick<Project, "name" | "audience" | "voice" | "cta" | "notes">): string {
  const head = [
    `Project: ${p.name}`,
    p.audience ? `Audience: ${p.audience}` : "",
    p.voice ? `Voice: ${p.voice}` : "",
    p.cta ? `CTA and links: ${p.cta}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const notes = p.notes.trim();
  if (!notes) return head;
  const label = "\nInstructions:\n";
  const room = Math.max(0, INSTRUCTIONS_MAX - head.length - label.length);
  if (!room) return head;
  const body = notes.length <= room ? notes : `${notes.slice(0, room).trimEnd()}\n…[shortened]`;
  return `${head}${label}${body}`;
}

/** Instructions and indexes — stable across turns. Instagram stats are not inlined. */
export function renderProjectStable(
  p: Pick<Project, "name" | "audience" | "voice" | "cta" | "notes" | "knowledge">,
  account?: Pick<AccountContext, "username" | "fullName"> | null,
): string {
  return [renderInstructions(p), account ? renderAccountIndex(account) : "", contextIndex(p.knowledge ?? [])].filter(Boolean).join("\n");
}

/** Capped instructions always on; context is an index, plus any files loaded this turn. */
export function renderProjectPrompt(
  p: Pick<Project, "name" | "audience" | "voice" | "cta" | "notes" | "knowledge">,
  opts?: { loaded?: KnowledgeFile[]; excerpts?: boolean; account?: AccountContext | null },
): string {
  return [
    renderProjectStable(p, opts?.account),
    opts?.loaded?.length ? renderLoadedKnowledge(opts.loaded) : opts?.excerpts ? generateExcerpts(p.knowledge ?? []) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGeneratePrompt(input: PromptInput): { system: string; user: string } {
  const blocks: string[] = [];
  const p = input.project;
  if (p) blocks.push(renderProjectPrompt(p, { excerpts: true, account: input.account }));
  else if (input.account) blocks.push(renderAccountIndex(input.account));
  const ROLE_WORD: Record<FrameworkRole, string> = {
    narrative: "narrative shape — sets the order of the whole piece",
    persuasion: "persuasion formula — shapes how the piece asks",
    argument: "argument structure — shapes the reasoning",
  };
  const order: FrameworkRole[] = ["narrative", "persuasion", "argument"];
  const fws = [...(input.frameworks ?? [])].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const describe = (f: NonNullable<PromptInput["frameworks"]>[number]) =>
    [
      `Framework (${ROLE_WORD[f.role]}): ${f.name}${f.summary ? ` — ${f.summary}` : ""}`,
      `Steps:\n${f.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      f.whenToUse ? `When to use: ${f.whenToUse}` : "",
      f.example ? `Example: ${f.example}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  if (fws.length === 1) {
    blocks.push(describe(fws[0]!));
  } else if (fws.length > 1) {
    blocks.push(
      [
        `Frameworks to combine (${fws.length}): the narrative shape sets the order of the piece; every step of the persuasion and argument frameworks must be present inside it, merged where they overlap; make the structure visible.`,
        ...fws.map(describe),
      ].join("\n\n"),
    );
  }
  if (input.rules?.length) {
    blocks.push(`Rules for this piece (they always apply):\n${input.rules.map((r) => `- ${r}`).join("\n")}`);
  }
  const notes = input.notes.trim();
  if (notes) {
    blocks.push(`Session notes (the author's own observations while reading the sources):\n${notes.slice(0, NOTES_MAX)}`);
  }
  const brief = input.prompt.trim();
  if (brief) blocks.push(`Brief:\n${brief}`);
  blocks.push(`Deliverable: ${DELIVERABLE[input.kind]}`);
  input.packs.forEach((pack, i) => {
    blocks.push(
      [
        `Source ${i + 1} of ${input.packs.length}: @${pack.handle} — ${pack.kind} — ${pack.url}`,
        keptForLine(pack.savedFor),
        pack.note ? `How to use this source: ${pack.note}` : "",
        pack.markdown.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });
  return { system: `${SYSTEM_BASE}\n\n${KIND_SPEC[input.kind]}`, user: blocks.join("\n\n") };
}
