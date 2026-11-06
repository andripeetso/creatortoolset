import { type ReactNode, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ClipPlayer } from "@/components/ClipPlayer";
import {
  clipBlockLabels,
  getClip,
  playClipUrl,
  thumbClipUrl,
} from "@/lib/clips";
import {
  extractClipEmbeds,
  parseDocumentMarkdown,
} from "@/lib/document-markdown";
import { parseInlineMarkdown } from "@/lib/inline-markdown";

/**
 * Markdown renderer for document pages. Clip links become embedded videos.
 */

function inline(text: string): ReactNode[] {
  return parseInlineMarkdown(text).map((p, i) => {
    if (p.kind === "text") return p.text;
    if (p.kind === "image")
      return <img key={i} src={p.href} alt={p.text} loading="lazy" className="my-2 block max-h-[360px] w-auto max-w-full rounded-lg border border-border" />;
    if (p.kind === "strong") return <strong key={i}>{p.text}</strong>;
    if (p.kind === "em") return <em key={i}>{p.text}</em>;
    if (p.kind === "strongem")
      return (
        <strong key={i}>
          <em>{p.text}</em>
        </strong>
      );
    return (
      <a
        key={i}
        href={p.href}
        className="text-violet-700 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-600 dark:text-violet-300 dark:hover:text-violet-200"
      >
        {p.text}
      </a>
    );
  });
}

function seeDetailsLine(labels: string[]): string {
  if (!labels.length) return "See takeaways, action plan, and more";
  const lower = labels.map((s) => s.toLowerCase());
  if (lower.length === 1) return `See ${lower[0]}`;
  if (lower.length === 2) return `See ${lower[0]} and ${lower[1]}`;
  return `See ${lower.slice(0, -1).join(", ")}, and ${lower[lower.length - 1]}`;
}

function ClipEmbedHints({ id }: { id: string }) {
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    getClip(id)
      .then((s) => {
        if (!cancelled) setLabels(clipBlockLabels(s));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (
    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground group-hover:text-foreground/80">
      {seeDetailsLine(labels)}
    </span>
  );
}

function ClipEmbed({
  id,
  title,
  onOpenClip,
  media = true,
}: {
  id: string;
  title: string;
  onOpenClip?: (id: string, title: string) => void;
  media?: boolean;
}) {
  return (
    <figure className="my-5 overflow-hidden rounded-xl border border-border bg-black">
      {media ? (
        <ClipPlayer
          src={playClipUrl(id)}
          poster={thumbClipUrl(id)}
          embedded
        />
      ) : (
        <img
          src={thumbClipUrl(id)}
          alt=""
          className="aspect-video w-full bg-black object-cover"
        />
      )}
      <figcaption className="border-t border-border bg-muted">
        <button
          type="button"
          onClick={() => onOpenClip?.(id, title)}
          className="group flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-foreground">{title}</span>
            <ClipEmbedHints id={id} />
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </figcaption>
    </figure>
  );
}

export function MarkdownBody({
  source,
  onOpenClip,
  media = true,
}: {
  source: string;
  onOpenClip?: (id: string, title: string) => void;
  media?: boolean;
}) {
  const lines = parseDocumentMarkdown(source).replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={key++} className="my-3 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground">
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ");
    para = [];
    const { clips, rest } = extractClipEmbeds(text);
    for (const clip of clips) {
      blocks.push(
        <ClipEmbed
          key={key++}
          id={clip.id}
          title={clip.title}
          onOpenClip={onOpenClip}
          media={media}
        />,
      );
    }
    if (rest) {
      blocks.push(
        <p key={key++} className="my-3 text-[15px] leading-relaxed text-foreground">
          {inline(rest)}
        </p>,
      );
    }
  };

  for (const line of lines) {
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    const li = /^[-*]\s+(.+)$/.exec(line);
    if (h) {
      flushList();
      flushPara();
      const Tag = (h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3") as
        | "h1"
        | "h2"
        | "h3";
      const cls =
        Tag === "h1"
          ? "mt-2 mb-4 text-3xl font-semibold tracking-tight text-foreground"
          : Tag === "h2"
            ? "mt-8 mb-3 text-xl font-semibold text-foreground"
            : "mt-5 mb-2 text-base font-medium text-foreground";
      blocks.push(
        <Tag key={key++} className={cls}>
          {inline(h[2])}
        </Tag>,
      );
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

  if (!blocks.length) {
    return <p className="text-sm text-muted-foreground">This document is empty.</p>;
  }
  return <div className="max-w-none">{blocks}</div>;
}
