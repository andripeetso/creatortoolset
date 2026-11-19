import { useState } from "react";
import { ANALYSIS_DEFAULT, ANALYSIS_LEVELS, LIBRARY_WORDS, LOOK_BUDGET_DEFAULT, flagsOf, levelOf, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Card, InfoTip, Row, TextField } from "@/components/settings/ui";

/** Analysis: one Effort slider over the existing flags (UNIFIED-PRD §4.4), and the monthly budget link under it (§4.5). */
export function Effort({ library, save }: { library: LibrarySummary; save: (settings: Partial<LibrarySettings>) => Promise<unknown> }) {
  const [drag, setDrag] = useState<number | null>(null);
  const top = ANALYSIS_LEVELS.length - 1;
  const at = drag ?? ANALYSIS_LEVELS.findIndex((l) => l.value === levelOf(library.settings));
  return (
    <Card>
      <Row title={LIBRARY_WORDS.effort}>
        <div className="px-1">
          <Slider
            aria-label={LIBRARY_WORDS.effort}
            min={0}
            max={top}
            step={1}
            value={[at]}
            onValueChange={([n]) => setDrag(n!)}
            onValueCommit={([n]) => {
              setDrag(null);
              void save(flagsOf(ANALYSIS_LEVELS[n!]!.value));
            }}
          />
          {/* each label sits under its knob: the knob's centre is 8 px in from each end of the track (size-4 thumb) */}
          <div className="relative mt-2 h-10 text-xs text-muted-foreground">
            {ANALYSIS_LEVELS.map((l, n) => (
              <div
                key={l.value}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center whitespace-nowrap"
                style={{ left: `calc(8px + (100% - 16px) * ${n / top})` }}
              >
                <span className="inline-flex items-center">
                  {l.label}
                  <InfoTip text={LIBRARY_WORDS.effortTips[l.value]} label={l.label} />
                </span>
                {l.value === ANALYSIS_DEFAULT && <span className="text-[10px]">{LIBRARY_WORDS.recommended}</span>}
              </div>
            ))}
          </div>
          <div className="pt-2">
            <Budget library={library} save={save} />
          </div>
        </div>
      </Row>
    </Card>
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
