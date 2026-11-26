import type { ComponentType, ReactNode } from "react";
import { Check } from "lucide-react";
import type { WorkPrefs } from "@contracts/work-prefs";
import { cn } from "@/lib/utils";
import { AppArt, BothArt } from "./HowArt";

type Talk = WorkPrefs["talk"];

/**
 * Two answers (owner, 2026-11-26: three cards nobody could tell apart, and two of them led to the same setup). The one
 * thing setup needs to know is whether an AI app does the work too. No is `app`: setup is done. Yes is `both`: the next
 * screen adds Creator Toolset to the AI apps on this computer, and the work still shows in the app. Each card's line
 * says what picking it does next. `chat` (the AI app only, with the app's own assistant quiet) stays a saved answer an
 * AI app can set (api/mcp.ts); here it shows as the second card.
 */
const WAYS: Array<{ talk: Talk; name: string; what: string; art: ComponentType }> = [
  { talk: "app", name: "In the app", what: "Nothing more to set up.", art: AppArt },
  { talk: "both", name: "With an AI app", what: "Adds Creator Toolset to Claude Code or Codex on the next screen.", art: BothArt },
];

/** Setup's picture card (How do you work best?, Pick your look): a picture of the answer, its name and (`what`) one line. */
export function PictureCard({ on, onClick, art, name, what }: { on: boolean; onClick: () => void; art: ReactNode; name: string; what?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border text-center outline-none transition-[border-color,box-shadow,transform] duration-200",
        "focus-visible:ring-2 focus-visible:ring-[var(--tint)] motion-safe:hover:-translate-y-0.5",
        on ? "border-[var(--tint)] shadow-[0_0_0_1px_var(--tint),0_12px_32px_-12px_color-mix(in_srgb,var(--tint)_45%,transparent)]" : "border-border/70 hover:border-foreground/25",
      )}
    >
      <span
        className={cn(
          "flex aspect-[16/8] items-center justify-center border-b px-6 py-2 transition-colors",
          on ? "border-[color-mix(in_srgb,var(--tint)_35%,transparent)] bg-[color-mix(in_srgb,var(--tint)_10%,transparent)]" : "border-border/60 bg-muted/40",
        )}
      >
        {art}
      </span>
      <span className={cn("flex flex-1 flex-col items-center px-4 pb-4 pt-3.5", on && "bg-[color-mix(in_srgb,var(--tint)_4%,transparent)]")}>
        <span className="text-[15px] font-semibold text-foreground">{name}</span>
        {what && <span className="mt-1 max-w-[17rem] text-balance text-[13px] leading-snug text-muted-foreground">{what}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border transition-all",
          on ? "border-[var(--tint)] bg-[var(--tint)] text-white" : "border-foreground/20 bg-background/80",
        )}
      >
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

/** Setup's question about where they talk to the AI (work-prefs `talk`). Two cards side by side, each a picture of it. */
export function HowPicker({ value, onChange }: { value: Talk; onChange: (v: Talk) => void }) {
  return (
    <div role="radiogroup" aria-label="How do you work best?" className="grid gap-4 sm:grid-cols-2">
      {WAYS.map((w) => (
        <PictureCard key={w.talk} on={w.talk === value || (w.talk === "both" && value === "chat")} onClick={() => onChange(w.talk)} art={<w.art />} name={w.name} what={w.what} />
      ))}
    </div>
  );
}
