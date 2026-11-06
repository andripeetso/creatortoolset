import { extractClipEmbeds, parseDocumentMarkdown } from "./document-markdown";
import { parseInlineMarkdown } from "./inline-markdown";
import { playClipUrl, thumbClipUrl } from "./clips";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineHtml(text: string): string {
  return parseInlineMarkdown(text)
    .map((p) => {
      if (p.kind === "text") return esc(p.text);
      if (p.kind === "strong") return `<strong>${esc(p.text)}</strong>`;
      if (p.kind === "em") return `<em>${esc(p.text)}</em>`;
      if (p.kind === "strongem") return `<strong><em>${esc(p.text)}</em></strong>`;
      return `<a href="${esc(p.href)}">${esc(p.text)}</a>`;
    })
    .join("");
}

function clipFigure(id: string, title: string): string {
  return `<figure contenteditable="false" data-clip-id="${esc(id)}" data-clip-title="${esc(title)}" class="my-5 overflow-hidden rounded-xl border border-border bg-black"><video src="${esc(playClipUrl(id))}" poster="${esc(thumbClipUrl(id))}" controls playsinline preload="metadata" class="aspect-video w-full bg-black"></video><figcaption class="border-t border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground"><button type="button" data-clip-open="${esc(id)}" class="flex w-full min-w-0 items-center gap-1.5 text-left hover:text-foreground"><span class="min-w-0 flex-1"><span class="block truncate text-foreground">${esc(title)}</span><span class="mt-0.5 block truncate text-[11px] text-muted-foreground">See takeaways, action plan, and more</span></span><span aria-hidden="true" class="shrink-0 text-muted-foreground">↗</span></button></figcaption></figure>`;
}

export function markdownToHtml(source: string): string {
  const lines = parseDocumentMarkdown(source).replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let list: string[] = [];
  let para: string[] = [];

  const flushList = () => {
    if (!list.length) return;
    blocks.push(
      `<ul class="my-3 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground">${list.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</ul>`,
    );
    list = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ");
    para = [];
    const { clips, rest } = extractClipEmbeds(text);
    for (const clip of clips) blocks.push(clipFigure(clip.id, clip.title));
    if (rest) {
      blocks.push(
        `<p class="my-3 text-[15px] leading-relaxed text-foreground">${inlineHtml(rest)}</p>`,
      );
    }
  };

  for (const line of lines) {
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    const li = /^[-*]\s+(.+)$/.exec(line);
    if (h) {
      flushList();
      flushPara();
      const n = h[1].length;
      const cls =
        n === 1
          ? "mt-2 mb-4 text-3xl font-semibold tracking-tight text-foreground"
          : n === 2
            ? "mt-8 mb-3 text-xl font-semibold text-foreground"
            : "mt-5 mb-2 text-base font-medium text-foreground";
      blocks.push(`<h${n} class="${cls}">${inlineHtml(h[2])}</h${n}>`);
    } else if (li) {
      flushPara();
      list.push(li[1]);
    } else if (!line.trim()) {
      flushList();
      flushPara();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushList();
  flushPara();
  return blocks.join("");
}

function inlineToMd(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      out += node.textContent ?? "";
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName;
    const inner = inlineToMd(node);
    if (tag === "STRONG" || tag === "B") out += `**${inner}**`;
    else if (tag === "EM" || tag === "I") out += `*${inner}*`;
    else if (tag === "A") {
      const href = node.getAttribute("href") || "";
      out += href ? `[${inner}](${href})` : inner;
    } else out += inner;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function htmlToMarkdown(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName;
    const clipId = el.getAttribute("data-clip-id");
    if (clipId) {
      const title = el.getAttribute("data-clip-title") || "Clip";
      parts.push(`[${title}](/clips/${clipId})`);
      return;
    }
    if (tag === "H1") parts.push(`# ${inlineToMd(el)}`);
    else if (tag === "H2") parts.push(`## ${inlineToMd(el)}`);
    else if (tag === "H3") parts.push(`### ${inlineToMd(el)}`);
    else if (tag === "P" || tag === "DIV") {
      const t = inlineToMd(el);
      if (t) parts.push(t);
    } else if (tag === "UL") {
      const items = Array.from(el.children)
        .filter((c) => c.tagName === "LI")
        .map((li) => `- ${inlineToMd(li)}`);
      if (items.length) parts.push(items.join("\n"));
    } else if (tag === "OL") {
      const items = Array.from(el.children)
        .filter((c) => c.tagName === "LI")
        .map((li, i) => `${i + 1}. ${inlineToMd(li)}`);
      if (items.length) parts.push(items.join("\n"));
    } else if (tag === "BR") parts.push("");
    else {
      for (const child of Array.from(el.children)) walk(child);
    }
  };
  for (const child of Array.from(root.children)) walk(child);
  if (!parts.length) {
    const t = inlineToMd(root);
    return t;
  }
  return parts.join("\n\n").trim();
}
