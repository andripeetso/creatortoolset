import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { parseInlineMarkdown, stripInlineMarkdown } from "@/lib/inline-markdown";
import { ROLE_LABEL, type CardLayout, type ImageWellSize, type VisualSlide } from "@/lib/carousel-visualize";

const NATIVE_W = 320;
const NATIVE_H = 400;
const display: CSSProperties = {
  fontFamily: '"Inter", "Helvetica Neue", sans-serif',
  fontWeight: 700,
};

function InlineMd({ text }: { text: string }) {
  return (
    <>
      {parseInlineMarkdown(text).map((p, i) => {
        if (p.kind === "text") return <span key={i}>{p.text}</span>;
        if (p.kind === "em") return <em key={i}>{p.text}</em>;
        if (p.kind === "strong") return <strong key={i}>{p.text}</strong>;
        if (p.kind === "strongem")
          return (
            <strong key={i}>
              <em>{p.text}</em>
            </strong>
          );
        return (
          <a key={i} href={p.href} className="underline decoration-current/40 underline-offset-2">
            {p.text}
          </a>
        );
      })}
    </>
  );
}

function Copy({
  text,
  empty,
  className,
  style,
  dark,
}: {
  text: string;
  empty: string;
  className?: string;
  style?: CSSProperties;
  dark?: boolean;
}) {
  if (stripInlineMarkdown(text).trim()) {
    return (
      <p className={className} style={style}>
        <InlineMd text={text} />
      </p>
    );
  }
  return (
    <p
      className={cn(
        "rounded-sm border border-dashed px-1.5 py-1",
        dark ? "border-white/25 text-white/35" : "border-[#171614]/25 text-[#171614]/35",
        className,
      )}
      style={style}
    >
      {empty}
    </p>
  );
}

function AreaStack({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      {parts.map((p, i) => (
        <p key={i} className="text-[15px] leading-[1.45] text-[#171614]/80">
          <InlineMd text={p} />
        </p>
      ))}
    </div>
  );
}

function ImageWell({ size, className }: { size: ImageWellSize; className?: string }) {
  const hole = "rounded-sm bg-[#171614]/[0.09]";
  if (size === "pair") {
    return (
      <div className={cn("grid shrink-0 grid-cols-2 gap-2", className)} aria-hidden>
        <div className={cn(hole, "h-[88px]")} />
        <div className={cn(hole, "h-[88px]")} />
      </div>
    );
  }
  const box =
    size === "banner" ? "h-[84px] w-full shrink-0" : size === "square" ? "aspect-square w-[44%] shrink-0" : size === "tall" ? "h-[156px] w-[34%] shrink-0" : "h-[32px] w-full shrink-0";
  return <div className={cn(hole, box, className)} aria-hidden />;
}

/** Cover/closer: first area hero, middle support, last kicker — blank lines stay as separate regions. */
function Sandwich({
  slide,
  empty,
  hero,
}: {
  slide: VisualSlide;
  empty: string;
  hero?: boolean;
}) {
  const { headline, body, kicker } = slide.parsed;
  const well = slide.well;
  const long = stripInlineMarkdown(headline).length > 70;
  const titleClass = hero
    ? long
      ? "text-[22px] leading-[1.18] tracking-[-0.03em]"
      : "text-[34px] leading-[1.12] tracking-[-0.03em]"
    : "text-[26px] leading-[1.15] tracking-[-0.03em]";
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4 p-7 text-[#171614]">
      {well === "banner" ? <ImageWell size="banner" /> : null}
      <Copy text={headline} empty={empty} className={titleClass} style={display} />
      {well === "square" || well === "tall" ? <ImageWell size={well} /> : null}
      {stripInlineMarkdown(body).trim() ? <AreaStack text={body} className="flex-1 justify-center" /> : <span className="min-h-0 flex-1" />}
      {stripInlineMarkdown(kicker).trim() ? (
        <p className="shrink-0 text-[15px] leading-snug text-[#171614]/70">
          <InlineMd text={kicker} />
        </p>
      ) : (
        <span />
      )}
      {well === "strip" ? <ImageWell size="strip" /> : null}
    </div>
  );
}

function CoverCard({ slide }: { slide: VisualSlide }) {
  return <Sandwich slide={slide} empty="Headline" hero />;
}

function TeachingCard({ slide }: { slide: VisualSlide }) {
  const { headline, body } = slide.parsed;
  const well = slide.well;
  const copy = (
    <>
      <Copy text={headline} empty="Headline" className="text-[22px] leading-[1.2] tracking-[-0.02em]" style={display} />
      {stripInlineMarkdown(body).trim() ? <AreaStack text={body} /> : <Copy text="" empty="Body" className="text-[15px] leading-[1.45]" />}
    </>
  );
  return (
    <div className="flex h-full flex-col gap-5 p-7 text-[#171614]">
      {well === "banner" ? <ImageWell size="banner" /> : null}
      {well === "square" || well === "tall" ? (
        <div className="flex min-h-0 flex-1 items-start gap-3">
          <ImageWell size={well} />
          <div className="flex min-w-0 flex-1 flex-col gap-5">{copy}</div>
        </div>
      ) : (
        copy
      )}
      {well === "strip" ? <ImageWell size="strip" className="mt-auto" /> : null}
    </div>
  );
}

function TwoColCard({ slide }: { slide: VisualSlide }) {
  const { left, right, leftTitle, rightTitle, question } = slide.parsed;
  const well = slide.well;
  const col = (title: string | undefined, text: string | undefined, empty: string) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      {well === "pair" ? <div className="mb-1 h-[72px] w-full shrink-0 rounded-sm bg-[#171614]/[0.09]" aria-hidden /> : null}
      {title ? (
        <p className="text-[15px] leading-snug tracking-[-0.02em]" style={display}>
          <InlineMd text={title} />
        </p>
      ) : null}
      {stripInlineMarkdown(text ?? "").trim() ? <AreaStack text={text!} className="gap-2" /> : <Copy text="" empty={empty} className="text-[13px]" />}
    </div>
  );
  return (
    <div className="flex h-full flex-col p-5 text-[#171614]">
      {well === "banner" ? <ImageWell size="banner" className="mb-3" /> : null}
      <div className="flex min-h-0 flex-1 gap-0">
        {col(leftTitle, left, "Approach A")}
        <div className="mx-3 w-px shrink-0 bg-[#171614]/12" />
        {col(rightTitle, right, "Approach B")}
      </div>
      {well === "tall" ? <ImageWell size="tall" className="mt-3" /> : null}
      {question ? (
        <p className="shrink-0 pt-3 text-center text-[13px] leading-snug text-[#171614]/70" style={display}>
          <InlineMd text={question} />
        </p>
      ) : null}
    </div>
  );
}

function ReplaceCard({ slide }: { slide: VisualSlide }) {
  const { said, instead, why, headline } = slide.parsed;
  const well = slide.well;
  return (
    <div className="flex h-full flex-col p-5 text-[#171614]">
      {well === "banner" ? <ImageWell size="banner" className="mb-3" /> : null}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col gap-2 border-t-2 border-[#171614]/20 pt-3">
          {well === "pair" ? <div className="h-[72px] w-full shrink-0 rounded-sm bg-[#171614]/[0.09]" aria-hidden /> : null}
          <p className="text-[11px] text-[#171614]/45">They say</p>
          <Copy text={said || headline} empty="Familiar phrase" className="text-[16px] leading-snug tracking-[-0.02em]" style={display} />
          {why ? <AreaStack text={why} className="gap-2" /> : null}
        </div>
        <div className="flex min-h-0 flex-col gap-2 border-t-2 border-[#171614] pt-3">
          {well === "pair" ? <div className="h-[72px] w-full shrink-0 rounded-sm bg-[#171614]/[0.09]" aria-hidden /> : null}
          <p className="text-[11px] text-[#171614]/45">Do this</p>
          <Copy text={instead ?? ""} empty="The replacement" className="text-[16px] leading-snug tracking-[-0.02em]" style={display} />
        </div>
      </div>
      {well === "tall" ? <ImageWell size="tall" className="mt-3" /> : null}
    </div>
  );
}

function MythCard({ slide }: { slide: VisualSlide }) {
  const { label, headline, body } = slide.parsed;
  return (
    <div className="flex h-full flex-col p-7 text-[#171614]">
      {label ? <p className="text-[12px] text-[#171614]/45">{label}</p> : null}
      <Copy text={headline} empty="The belief" className="mt-2 text-[22px] leading-[1.18] tracking-[-0.03em]" style={display} />
      {stripInlineMarkdown(body).trim() ? <AreaStack text={body} className="mt-4" /> : <Copy text="" empty="The correction" className="mt-4 text-[15px]" />}
      {slide.well ? <ImageWell size={slide.well} className="mt-4" /> : null}
    </div>
  );
}

function CaseCard({ slide }: { slide: VisualSlide }) {
  const { label, headline, body } = slide.parsed;
  const well = slide.well;
  return (
    <div className="flex h-full flex-col p-7 text-[#171614]">
      {well === "banner" ? <ImageWell size="banner" className="mb-3" /> : null}
      {label ? <p className="text-[12px] text-[#171614]/50">{label}</p> : null}
      <Copy text={headline} empty="The practice" className="mt-2 text-[22px] leading-[1.18] tracking-[-0.03em]" style={display} />
      {well === "square" || well === "tall" ? <ImageWell size={well} className="mt-4" /> : null}
      {stripInlineMarkdown(body).trim() ? <AreaStack text={body} className="mt-4" /> : null}
      {well === "strip" ? <ImageWell size="strip" className="mt-auto" /> : null}
    </div>
  );
}

function ThreadCard({ slide }: { slide: VisualSlide }) {
  const msgs = slide.parsed.messages ?? [];
  return (
    <div className="flex h-full flex-col justify-end gap-2 bg-[#ecebe6] p-5">
      {msgs.length ? (
        msgs.map((m, i) => (
          <div key={i} className={cn("flex", m.from === "you" ? "justify-end" : "justify-start")}>
            <p
              className={cn(
                "max-w-[85%] rounded-[16px] px-3 py-2 text-[13px] leading-snug",
                m.from === "you" ? "bg-[#0a84ff] text-white" : "bg-white text-[#171614]",
              )}
            >
              <InlineMd text={m.text} />
            </p>
          </div>
        ))
      ) : (
        <p className="text-[13px] text-[#171614]/40">them: … / you: …</p>
      )}
      {slide.well ? <ImageWell size={slide.well} /> : null}
    </div>
  );
}

function CloserCard({ slide }: { slide: VisualSlide }) {
  return <Sandwich slide={slide} empty="Takeaway" />;
}

const LAYOUT: Record<CardLayout, (p: { slide: VisualSlide }) => ReactNode> = {
  cover: CoverCard,
  teaching: TeachingCard,
  twoCol: TwoColCard,
  replace: ReplaceCard,
  myth: MythCard,
  case: CaseCard,
  thread: ThreadCard,
  closer: CloserCard,
};

export function CarouselSlideFace({ slide }: { slide: VisualSlide }) {
  const Face = LAYOUT[slide.layout];
  return (
    <div className={cn("h-full w-full overflow-hidden bg-[#f3f2ed] text-left shadow-[inset_0_0_0_1px_rgba(23,22,20,0.08)]", slide.ghost && "bg-[#ecebe6]")}>
      <Face slide={slide} />
    </div>
  );
}

/** Scale a 320×400 face to `width` while keeping 4:5. */
export function CarouselSlideCard({
  slide,
  width = NATIVE_W,
  className,
}: {
  slide: VisualSlide;
  width?: number;
  className?: string;
}) {
  const scale = width / NATIVE_W;
  return (
    <div
      className={cn("relative overflow-hidden rounded-[4px] shadow-[0_18px_40px_-24px_rgba(0,0,0,0.7)]", slide.ghost && "opacity-70", className)}
      style={{ width, height: width * (NATIVE_H / NATIVE_W) }}
    >
      <div className="origin-top-left" style={{ width: NATIVE_W, height: NATIVE_H, transform: `scale(${scale})` }}>
        <CarouselSlideFace slide={slide} />
      </div>
    </div>
  );
}

export function slideChrome(slide: VisualSlide): string {
  const role = ROLE_LABEL[slide.role];
  if (slide.ghost) return `Missing · ${role}`;
  if (slide.step && (slide.role === "myth" || slide.role === "case" || slide.role === "choice" || slide.role === "replace")) {
    return `Slide ${slide.n} · ${role} ${slide.step}`;
  }
  return `Slide ${slide.n} · ${role}`;
}
