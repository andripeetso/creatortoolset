import type { CSSProperties } from "react";
import type { Pack, PackCaptionStyle } from "@contracts/packs";
import { FONT_OPTIONS } from "@/lib/types";
import { packContents } from "./packs-helpers";

const FAMILIES = new Set(FONT_OPTIONS.map((f) => f.family));
const HEX6 = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown, fallback: string) => (typeof v === "string" && HEX6.test(v) ? v : fallback);

/**
 * A caption style drawn the way the app draws captions: its font (only the fonts the app ships), colour, outline and
 * box. It stands for the video, so it sits on a dark strip.
 */
export function CaptionSample({ style, big }: { style: PackCaptionStyle; big?: boolean }) {
  const s = style.style;
  const family = typeof s.fontFamily === "string" && FAMILIES.has(s.fontFamily) ? s.fontFamily : "Inter";
  const outline = hex(s.outlineColor, "#000000");
  const alpha = Math.round(Math.min(1, Math.max(0, typeof s.boxOpacity === "number" ? s.boxOpacity : 1)) * 255).toString(16).padStart(2, "0");
  const css: CSSProperties = {
    fontFamily: `"${family}", sans-serif`,
    color: hex(s.textColor, "#ffffff"),
    textTransform: s.uppercase ? "uppercase" : undefined,
    backgroundColor: s.boxEnabled ? `${hex(s.boxColor, "#000000")}${alpha}` : undefined,
    padding: s.boxEnabled ? "0.1em 0.4em" : undefined,
    textShadow:
      typeof s.outlineWidth === "number" && s.outlineWidth > 0
        ? `1px 0 0 ${outline}, -1px 0 0 ${outline}, 0 1px 0 ${outline}, 0 -1px 0 ${outline}`
        : undefined,
  };
  return (
    <span className={big ? "text-3xl leading-tight" : "text-base leading-tight"} style={css}>
      {style.name}
    </span>
  );
}

/**
 * The start of a pack, from its own content: the first framework (name and steps), else its caption styles, else the
 * first instruction this app uses, as a quote. The card's preview and the detail page's top.
 */
export function PackPreview({ pack, big }: { pack: Pack; big?: boolean }) {
  const fw = pack.frameworks?.[0];
  if (fw)
    return (
      <div className="flex h-full min-w-0 flex-col justify-center overflow-hidden p-3">
        <div className="truncate text-sm font-medium text-foreground">{fw.name}</div>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
          {fw.steps.slice(0, big ? undefined : 3).map((step, i) => (
            <li key={i} className="truncate">
              {step}
            </li>
          ))}
        </ol>
      </div>
    );

  const styles = pack.captionStyles ?? [];
  if (styles.length)
    return (
      <div className="flex h-full flex-wrap content-center items-center justify-center gap-x-4 gap-y-2 bg-zinc-900 p-3">
        {styles.slice(0, big ? 8 : 3).map((st, i) => (
          <CaptionSample key={i} style={st} big={big} />
        ))}
      </div>
    );

  const text = packContents(pack).slots[0]?.text;
  return (
    <div className="flex h-full items-center overflow-hidden p-3">
      {text ? (
        <p className="line-clamp-4 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">{text}</p>
      ) : (
        <span className="text-xs text-muted-foreground">Nothing to preview.</span>
      )}
    </div>
  );
}
