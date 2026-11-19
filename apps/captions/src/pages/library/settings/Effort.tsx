import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ANALYSIS_DEFAULT, ANALYSIS_LEVELS, LIBRARY_WORDS, LOOK_BUDGET_DEFAULT, flagsOf, levelOf, type AnalysisLevel, type LibraryEstimate, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, InfoTip, Row, TextField } from "@/components/settings/ui";
import { getEstimate } from "@/lib/library";

/** Analysis: Effort's six stops over the existing flags (UNIFIED-PRD §4.4), and the monthly budget link under it (§4.5). */
export function Effort({ library, save }: { library: LibrarySummary; save: (settings: Partial<LibrarySettings>) => Promise<unknown> }) {
  const level = levelOf(library.settings);
  return (
    <Card>
      <Row title={LIBRARY_WORDS.effort} tip={LIBRARY_WORDS.effortTips[level]} control={<EffortCost libraryId={library.id} level={level} />}>
        <EffortStops value={level} onPick={(l) => void save(flagsOf(l))} />
        <div className="pt-3">
          <Budget library={library} save={save} />
        </div>
      </Row>
    </Card>
  );
}

/** Effort's six stops in a row (11-19 sign-off B7): the one control, in the setup and on the owner's settings page. */
export function EffortStops({ value, onPick }: { value: AnalysisLevel; onPick: (level: AnalysisLevel) => void }) {
  return (
    <div role="radiogroup" aria-label={LIBRARY_WORDS.effort} className="grid grid-cols-3 overflow-hidden rounded-lg border sm:grid-cols-6">
      {ANALYSIS_LEVELS.map((l) => (
        <button
          key={l.value}
          type="button"
          role="radio"
          aria-checked={value === l.value}
          title={l.value === ANALYSIS_DEFAULT ? LIBRARY_WORDS.recommended : undefined}
          onClick={() => onPick(l.value)}
          className={cn(
            "border-l px-1 py-1.5 text-xs outline-none first:border-l-0 focus-visible:ring-2 [&:nth-child(4)]:border-l-0 [&:nth-child(n+4)]:border-t sm:[&:nth-child(4)]:border-l sm:[&:nth-child(n+4)]:border-t-0 focus-visible:ring-inset focus-visible:ring-violet-600",
            value === l.value ? "bg-violet-600/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/**
 * "About $N" at the right of the Effort row (UNIFIED-PRD §3.1): what the footage not analyzed yet costs, from the
 * library's estimate. Hidden at Off (and while the estimate is not there).
 * shortcut: priced from the library's saved settings, so Setup (which holds its answer until Finish) shows the saved figure.
 */
export function EffortCost({ libraryId, level }: { libraryId: string; level: AnalysisLevel }) {
  const [cost, setCost] = useState<LibraryEstimate["unanalyzed"] | null>(null);
  useEffect(() => {
    let live = true;
    getEstimate(libraryId, { clips: 0, bytes: 0 })
      .then((e) => live && setCost(e.unanalyzed ?? null))
      .catch(() => live && setCost(null));
    return () => {
      live = false;
    };
  }, [libraryId]);
  if (level === "off" || !cost) return null;
  const hours = cost.seconds / 3600;
  return (
    <span className="inline-flex items-center text-xs text-muted-foreground">
      {`About $${Math.round(hours * cost.hourUsd)}`}
      <InfoTip text={`Cost to analyze the ${Math.round(hours)} hours not analyzed yet at this effort. New footage costs about $${cost.hourUsd.toFixed(2)} an hour.`} label={LIBRARY_WORDS.effort} />
    </span>
  );
}

/** The quiet link under the slider, and its popover: a dollar cap a month, or No limit (the default for a new library). */
function Budget({ library, save }: { library: LibrarySummary; save: (settings: Partial<LibrarySettings>) => Promise<unknown> }) {
  const cap = library.settings.lookBudget;
  const shown = cap === null ? LIBRARY_WORDS.budget.noLimit : `$${cap}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground">
          {`${LIBRARY_WORDS.budget.label}: ${shown}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-3 text-sm">
        <div className="flex items-center font-medium">
          {LIBRARY_WORDS.budget.label}
          <InfoTip text={LIBRARY_WORDS.budget.tip} label={LIBRARY_WORDS.budget.label} />
        </div>
        <div className="flex items-center gap-2">
          <span>$</span>
          <TextField
            label={LIBRARY_WORDS.budget.label}
            value={cap === null ? "" : String(cap)}
            disabled={cap === null}
            className="sm:w-24"
            onCommit={(t) => {
              const text = t.trim();
              // an empty field is no limit; anything else must be a dollar amount
              if (text === "") return save({ lookBudget: null });
              const usd = Number(text);
              if (Number.isFinite(usd) && usd >= 0) return save({ lookBudget: usd });
              throw new Error("Needs an amount in dollars");
            }}
          />
          <span>{LIBRARY_WORDS.budget.amount}</span>
        </div>
        <label className="flex items-center gap-2">
          <Checkbox checked={cap === null} onCheckedChange={(on) => void save({ lookBudget: on ? null : LOOK_BUDGET_DEFAULT })} />
          {LIBRARY_WORDS.budget.noLimit}
        </label>
      </PopoverContent>
    </Popover>
  );
}
