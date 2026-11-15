import { useState } from "react";
import { DEFAULT_FOLDERS, type LibrarySummary, type Organize } from "@contracts/library";
import { updateLibrary } from "@/lib/library";

/**
 * How the Media Library is organized (api/library/organize.ts): asked in place on its first run, and kept in Library
 * settings. Each choice says what it makes; the meaning is in the names, not in a line under them.
 */

/** The default folders' names, in their order: what Default folders makes. */
export const FOLDER_NAMES = DEFAULT_FOLDERS.map((f) => f.name).join(", ");

export const ORGANIZE: { value: Organize; label: string; detail: string }[] = [
  { value: "default", label: "Default folders", detail: FOLDER_NAMES },
  { value: "ai", label: "AI organizes", detail: "The same folders, and the AI files everything that comes in" },
  { value: "own", label: "My own folders", detail: "No folders made" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The first run's question, as three choices: the library is saved with the answer and its folders are read again (`onChosen`). */
export function OrganizeChoice({ library, onChosen, onError }: { library: LibrarySummary; onChosen: (l: LibrarySummary) => Promise<void>; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const choose = async (organize: Organize) => {
    setBusy(true);
    try {
      await onChosen(await updateLibrary(library.id, { settings: { organize } }));
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Organize the library" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Organize the library</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {ORGANIZE.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={busy}
            onClick={() => void choose(o.value)}
            className="flex flex-col gap-1 rounded-xl border border-zinc-500/20 p-3 text-left transition-colors hover:border-violet-500/50 disabled:opacity-60"
          >
            <span className="text-sm font-medium">{o.label}</span>
            <span className="text-xs text-zinc-500">{o.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
