import { useState } from "react";
import { Star } from "lucide-react";
import {
  IDEA_STATUSES,
  KNOWHOW,
  RANK_STARS,
  SAVED_FOR,
  ideaStatusOf,
  starsFromRank,
  toggleSavedFor,
  effectiveSavedFor,
  type IdeaStatus,
  type SavedFor,
} from "@/lib/instagram";

const STATUS_CLASS: Record<IdeaStatus, string> = {
  inbox: "border-zinc-700 text-zinc-300",
  idea: "border-violet-500/50 text-violet-200",
  done: "border-emerald-500/40 text-emerald-300",
  skip: "border-zinc-800 text-zinc-500",
};

export function IdeaStatusSelect({
  value,
  onChange,
  disabled,
  inSession,
}: {
  value: IdeaStatus | undefined;
  onChange: (status: IdeaStatus) => void;
  disabled?: boolean;
  /** A Workshop session uses it: it is filed under To make, so say so. */
  inSession?: boolean;
}) {
  const stored = ideaStatusOf(value);
  const current = inSession && stored === "inbox" ? "idea" : stored;
  return (
    <select
      value={current}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as IdeaStatus)}
      className={`rounded-md border bg-zinc-950 px-1.5 py-1 text-[11px] ${STATUS_CLASS[current]} disabled:opacity-50`}
      title={inSession ? "To make: a Workshop session uses it" : "Inbox, to make, done, or skip"}
    >
      {IDEA_STATUSES.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/** Know-how chip colours, shared with the paste boxes. */
export const KNOWHOW_CHIP = (on: boolean) =>
  on
    ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
    : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300";

export function SavedForToggle({
  value,
  onChange,
  disabled,
  knowhow,
  onKnowhow,
}: {
  value: SavedFor[] | undefined;
  onChange: (next: SavedFor[]) => void;
  disabled?: boolean;
  /** With `onKnowhow`, a Know-how chip that replaces content / format while it is on. */
  knowhow?: boolean;
  onKnowhow?: (on: boolean) => void;
}) {
  const current = knowhow ? [] : effectiveSavedFor(value);
  return (
    <div
      role="group"
      aria-label="Why you kept this"
      className="flex items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      {SAVED_FOR.map((s) => {
        const on = current.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            title={s.hint}
            onClick={() => onChange(knowhow ? [s.id] : toggleSavedFor(current, s.id))}
            className={`rounded-md border px-1.5 py-1 text-[11px] disabled:opacity-50 ${
              on
                ? s.id === "format"
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
                  : "border-violet-500/50 bg-violet-500/15 text-violet-200"
                : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
            }`}
          >
            {s.label}
          </button>
        );
      })}
      {onKnowhow && (
        <button
          type="button"
          disabled={disabled}
          aria-pressed={!!knowhow}
          title={KNOWHOW.hint}
          onClick={() => onKnowhow(!knowhow)}
          className={`rounded-md border px-1.5 py-1 text-[11px] disabled:opacity-50 ${KNOWHOW_CHIP(!!knowhow)}`}
        >
          {KNOWHOW.label}
        </button>
      )}
    </div>
  );
}

export function RankStars({
  value,
  onChange,
  disabled,
  onMedia,
}: {
  value: number | undefined;
  onChange: (rank: number | null) => void;
  disabled?: boolean;
  /** On a picture's dark bar (a card under the pointer): white outlines, a size up. */
  onMedia?: boolean;
}) {
  const shown = starsFromRank(value);
  const [hover, setHover] = useState<number | null>(null);
  const lit = hover ?? shown;
  return (
    <div
      role="radiogroup"
      aria-label="Rating"
      className={`flex items-center ${onMedia ? "gap-0.5" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: RANK_STARS }, (_, i) => i + 1).map((n) => {
        const filled = n <= lit;
        const preview = hover !== null && filled;
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            aria-label={n === 1 ? "1 star" : `${n} stars`}
            aria-checked={shown === n}
            role="radio"
            onMouseEnter={() => !disabled && setHover(n)}
            onFocus={() => !disabled && setHover(n)}
            onBlur={() => setHover(null)}
            onClick={() => onChange(shown === n ? null : n)}
            className={`rounded disabled:opacity-50 ${onMedia ? "text-white/85" : "p-0.5 text-zinc-600"}`}
          >
            <Star
              className={`${onMedia ? "h-4 w-4" : "h-3.5 w-3.5"} transition-colors ${
                filled
                  ? preview
                    ? "fill-amber-300 text-amber-300"
                    : "fill-amber-400 text-amber-400"
                  : ""
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
