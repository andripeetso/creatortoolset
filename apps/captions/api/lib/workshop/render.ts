import type { DraftPlan } from "./plans";

export interface RenderContext {
  projectName?: string;
  frameworkNames?: string[];
  sources: Array<{ handle: string; kind: string; url: string }>;
  /** Epoch ms; rendered as YYYY-MM-DD. */
  generatedAt: number;
}

const KIND_WORD = { reel: "Reel script", carousel: "Carousel", ad: "Ad copy", free: "Draft" } as const;
const LETTERS = "ABCDEFGH";

function byline(kind: keyof typeof KIND_WORD, ctx: RenderContext): string {
  const parts = [KIND_WORD[kind], ctx.projectName, ctx.frameworkNames?.join(" + "), new Date(ctx.generatedAt).toISOString().slice(0, 10)];
  return `_${parts.filter(Boolean).join(" · ")}_`;
}

function bullets(list: string[]): string[] {
  return list.map((l) => `- ${l}`);
}

function captionBlock(caption: string, hashtags: string[]): string[] {
  const out: string[] = [];
  if (caption) out.push("## Caption", "", caption, "");
  if (hashtags.length) out.push(hashtags.map((h) => `#${h}`).join(" "), "");
  return out;
}

/** The draft as Markdown: title, byline, the piece in its own shape, and the sources it came from. */
export function renderDraft(draft: DraftPlan, ctx: RenderContext): string {
  const lines: string[] = [];
  if (draft.kind === "free") {
    const body = draft.plan.markdown.trim();
    if (!/^#\s/.test(body)) lines.push(`# ${draft.plan.title}`, "");
    lines.push(byline("free", ctx), "", body, "");
  } else {
    lines.push(`# ${draft.plan.title}`, "", byline(draft.kind, ctx), "");
  }
  if (draft.kind === "reel") {
    const p = draft.plan;
    lines.push("## Hook", "", `**Say:** ${p.hook.spoken}`);
    if (p.hook.onScreen) lines.push(`**On screen:** ${p.hook.onScreen}`);
    lines.push("", "## Script", "");
    p.beats.forEach((b, i) => {
      lines.push(`### ${i + 1}. ${b.label || `Beat ${i + 1}`}${b.seconds ? ` (~${b.seconds} s)` : ""}`, "");
      lines.push(`**Say:** ${b.spoken}`);
      if (b.onScreen) lines.push(`**On screen:** ${b.onScreen}`);
      if (b.visual) lines.push(`_Visual: ${b.visual}_`);
      lines.push("");
    });
    if (p.cta) lines.push("## CTA", "", p.cta, "");
    lines.push(...captionBlock(p.caption, p.hashtags));
    if (p.whyItWorks.length) lines.push("## Why it works", "", ...bullets(p.whyItWorks), "");
  } else if (draft.kind === "carousel") {
    const p = draft.plan;
    for (const s of p.slides) {
      lines.push(`## Slide ${s.n} — ${s.headline || "(no headline)"}`, "");
      if (s.body) lines.push(s.body, "");
      if (s.visual) lines.push(`_Visual: ${s.visual}_`, "");
    }
    lines.push(...captionBlock(p.caption, p.hashtags));
    if (p.whyItWorks.length) lines.push("## Why it works", "", ...bullets(p.whyItWorks), "");
  } else if (draft.kind === "ad") {
    const p = draft.plan;
    p.variants.forEach((v, i) => {
      lines.push(`## Variant ${LETTERS[i] ?? i + 1} — ${v.angle || "angle"}`, "");
      if (v.hook) lines.push(`**Hook:** ${v.hook}`, "");
      lines.push("**Primary text**", "", v.primaryText, "");
      if (v.headline) lines.push(`**Headline:** ${v.headline}`);
      if (v.description) lines.push(`**Description:** ${v.description}`);
      if (v.cta) lines.push(`**CTA:** ${v.cta}`);
      lines.push("");
    });
    if (p.whyItWorks.length) lines.push("## Why it works", "", ...bullets(p.whyItWorks), "");
  }
  if (ctx.sources.length) {
    lines.push("## Sources", "");
    for (const s of ctx.sources) lines.push(`- @${s.handle} — ${s.kind} — ${s.url}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
