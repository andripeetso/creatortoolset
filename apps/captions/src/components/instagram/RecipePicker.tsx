import {
  DEFAULT_RECIPE,
  JOB_GROUPS,
  customRecipe,
  isGroupOn,
  recipeFromPreset,
  recipeUsesHeavyJobs,
  type JobType,
  type Recipe,
  type RecipePreset,
} from "@/lib/instagram";

const PRESETS: { id: RecipePreset; label: string; hint: string }[] = [
  { id: "stats", label: "Stats", hint: "Caption, numbers, and the media itself" },
  { id: "watch", label: "Watch", hint: "Stats plus transcript & on-screen text" },
  { id: "full", label: "Full", hint: "Watch plus comments, tags, and the idea" },
  { id: "custom", label: "Custom", hint: "Your mix of jobs" },
];

function shortcutOf(jobs: JobType[]): RecipePreset {
  for (const id of ["stats", "watch", "full"] as const) {
    const want = recipeFromPreset(id).jobs;
    if (want.length === jobs.length && want.every((j) => jobs.includes(j))) return id;
  }
  return "custom";
}

/**
 * Presets are shortcuts that tick a set of switches; the switches stay
 * visible. Info and media are always on — a post is never saved without
 * its slides — and transcript + on-screen text are one switch.
 */
export function RecipePicker({
  recipe,
  onChange,
  compact,
  large,
}: {
  recipe: Recipe;
  onChange: (recipe: Recipe) => void;
  compact?: boolean;
  /** The paste box's size: bigger presets and checkboxes. */
  large?: boolean;
}) {
  // Compact hides the switches until Custom is picked, so Custom stays picked even
  // while its switches still match a preset.
  const current = compact && recipe.preset === "custom" ? "custom" : shortcutOf(recipe.jobs);
  const heavy = recipeUsesHeavyJobs(recipe);
  const showJobs = !compact || current === "custom";
  return (
    <div>
      <div className={`flex flex-wrap ${large ? "gap-2" : "gap-1.5"}`}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => {
              if (p.id === "custom") {
                onChange(customRecipe(recipe.jobs));
                return;
              }
              onChange(recipeFromPreset(p.id));
            }}
            className={`border ${large ? "rounded-lg px-3.5 py-1.5 text-sm" : "rounded-md px-2.5 py-1 text-[11px]"} ${
              current === p.id
                ? "border-violet-500/60 bg-violet-600/20 text-violet-100"
                : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {showJobs && (
        <div className={`flex flex-wrap ${large ? "mt-3 gap-x-5 gap-y-2" : "mt-2 gap-x-3 gap-y-1"}`}>
          {JOB_GROUPS.map((g) => {
            const on = g.locked || isGroupOn(recipe.jobs, g);
            return (
              <label
                key={g.id}
                title={g.hint}
                className={`flex items-center ${large ? "gap-2 text-sm" : "gap-1.5 text-[11px]"} ${g.locked ? "text-zinc-500" : "text-zinc-300"}`}
              >
                <input
                  type="checkbox"
                  disabled={g.locked}
                  checked={on}
                  onChange={(e) => {
                    const next = new Set(recipe.jobs);
                    for (const t of g.types) {
                      if (e.target.checked) next.add(t);
                      else next.delete(t);
                    }
                    onChange(customRecipe([...next]));
                  }}
                  className={`accent-violet-500 ${large ? "h-4 w-4" : ""}`}
                />
                {g.label}
              </label>
            );
          })}
        </div>
      )}
      {heavy && (
        <p className="mt-2 text-[11px] text-amber-400/80">This recipe scrapes comments.</p>
      )}
    </div>
  );
}

export { DEFAULT_RECIPE };
