import { useState, type ReactNode } from "react";
import { DEFAULT_FOLDERS, type Collection, type LibrarySummary, type Organize } from "@contracts/library";
import { listCollections, updateLibrary } from "@/lib/library";

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

/** An answer to the offer: the AI organizes from now on, or not, and it is not offered again (either way). */
export const offerAnswer = (ai: boolean) => ({ settings: ai ? { organize: "ai" as const, organizeOffered: true } : { organizeOffered: true } });

/** Whether a big folder into `library` offers the AI organizing it: not when the AI or the default folders already do, nor a second time. */
export const offersOrganize = (library: LibrarySummary | null | undefined) =>
  !!library && library.settings.organize !== "default" && library.settings.organize !== "ai" && !library.settings.organizeOffered;

/**
 * The Media Library page's organizing, for its owner. `choice`: the question, while it is unanswered and the library has
 * no plain folder of its own (one already organized by hand, or a new one from setup's folder that filled it, the same
 * way). `offer` / `answerOffer`: a big folder or drop offers the AI organizing it (BigUploadDialog), the answer saved
 * before the files come in. `organized`: the library saved, its folders read fresh (a refresh could join a read from
 * before the default folders were made, and the page hears no notice of its own writes).
 */
export function useOrganize({
  library,
  owner,
  folders,
  onSaved,
  setFolders,
  onError,
}: {
  library: LibrarySummary | null;
  owner: boolean;
  /** null while not read yet: nothing is asked until it is */
  folders: Collection[] | null;
  onSaved: (l: LibrarySummary) => void;
  setFolders: (c: Collection[]) => void;
  onError: (e: string) => void;
}): { choice: ReactNode; offer: boolean; answerOffer: (ai: boolean) => Promise<void>; organized: (l: LibrarySummary) => Promise<void> } {
  const organized = async (l: LibrarySummary) => {
    onSaved(l);
    setFolders(await listCollections(l.id));
  };
  const offer = owner && offersOrganize(library);
  const answerOffer = async (ai: boolean) => {
    if (!offer || !library) return;
    // a failed save never stops the files that wait on it
    await updateLibrary(library.id, offerAnswer(ai))
      .then(organized)
      .catch((e) => onError(message(e)));
  };
  const ask = owner && !!library && !library.settings.organize && !!folders && !folders.some((c) => c.kind === "manual" && c.parentId === null && c.name !== "Finals");
  return { choice: ask && library ? <OrganizeChoice library={library} onChosen={organized} onError={onError} /> : null, offer, answerOffer, organized };
}
