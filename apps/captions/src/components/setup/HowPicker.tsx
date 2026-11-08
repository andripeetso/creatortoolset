import type { ComponentType } from "react";
import { Check } from "lucide-react";
import type { WorkPrefs } from "@contracts/work-prefs";
import { cn } from "@/lib/utils";
import { AppArt, BothArt, ChatArt } from "./HowArt";

type Talk = WorkPrefs["talk"];

const WAYS: Array<{ talk: Talk; name: string; what: string; art: ComponentType }> = [
  {
    talk: "app",
    name: "In the app",
    what: "Plan, edit and review here. Your files stay on this Mac.",
    art: AppArt,
  },
  {
    talk: "chat",
    name: "In my own AI",
    what: "Keep chatting in Claude Code or Codex. Your files stay on this Mac.",
    art: ChatArt,
  },
  {
    talk: "both",
    name: "Both",
    what: "Chat in your AI, and see and edit the work here. Files stay on this Mac.",
    art: BothArt,
  },
];

/** Setup's first question: where they talk to the AI (work-prefs `talk`). Three cards side by side, each a picture of it. */
export function HowPicker({ value, onChange }: { value: Talk; onChange: (v: Talk) => void }) {
  return (
    <div role="radiogroup" aria-label="How do you work best?" className="grid gap-4 sm:grid-cols-3">
      {WAYS.map((w) => {
        const on = w.talk === value;
        return (
          <button
            key={w.talk}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(w.talk)}
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
              <w.art />
            </span>
            <span className={cn("flex flex-1 flex-col items-center px-4 pb-4 pt-3.5", on && "bg-[color-mix(in_srgb,var(--tint)_4%,transparent)]")}>
              <span className="text-[15px] font-semibold text-foreground">{w.name}</span>
              <span className="mt-1 max-w-[17rem] text-[13px] leading-snug text-muted-foreground">{w.what}</span>
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
      })}
    </div>
  );
}
