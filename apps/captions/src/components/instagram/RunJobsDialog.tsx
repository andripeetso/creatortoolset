import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { DEFAULT_RECIPE, type Recipe, type RunWhen } from "@/lib/instagram";
import { RecipePicker } from "./RecipePicker";

export function RunJobsDialog({
  title,
  confirmLabel = "Run",
  allowLater = false,
  busy = false,
  onClose,
  onRun,
}: {
  title: string;
  confirmLabel?: string;
  allowLater?: boolean;
  busy?: boolean;
  onClose: () => void;
  onRun: (recipe: Recipe, opts: { run: RunWhen; force: boolean }) => Promise<void>;
}) {
  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (run: RunWhen) => {
    setError(null);
    try {
      await onRun(recipe, { run, force });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-925 p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <RecipePicker recipe={recipe} onChange={setRecipe} />
        <label className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="accent-violet-500"
          />
          Redo what is already done
        </label>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          {allowLater && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit("later")}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              Save for later
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit("now")}
            className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
