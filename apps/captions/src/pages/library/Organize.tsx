import { type Collection, type LibrarySummary, type Organize } from "@contracts/library";
import { listCollections, updateLibrary } from "@/lib/library";

/**
 * How the Media Library is sorted into folders (api/library/organize.ts): asked in the dialog of the first upload or
 * folder (BigUploadDialog), and kept in Library settings. The folders are the library's own: files on disk never move.
 */

/** The default folders' names, in their order: the folders "Standard" makes (the list DEFAULT_FOLDERS held before its removal). U3 drops this option. */
export const FOLDER_NAMES = "A-roll, B-roll, Sound effects, Graphics, Examples";

/** The three choices by name, the same wherever they are offered (this dialog, Library settings). A name says what the choice does. */
export const ORGANIZE_NAME: Record<Organize, string> = { default: "Standard", ai: "Automatic", own: "None" };

export const ORGANIZE: { value: Organize; label: string; detail: string }[] = [
  { value: "default", label: ORGANIZE_NAME.default, detail: `The library has the folders ${FOLDER_NAMES}.` },
  { value: "ai", label: ORGANIZE_NAME.ai, detail: "Folders are made to fit the footage, and each new file is filed in one." },
  { value: "own", label: ORGANIZE_NAME.own, detail: "Files stay in one list." },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The three choices as radio cards, for the upload dialog. */
export function OrganizePicker({ value, onChange }: { value: Organize; onChange: (o: Organize) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Folders</legend>
      {ORGANIZE.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-zinc-500/20 px-3 py-2.5 has-[:checked]:border-violet-500/60">
          <input type="radio" name="organize" className="mt-1 accent-violet-500" checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{o.label}</span>
            <span className="text-xs text-zinc-500">{o.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** An answer to the question: saved, and not asked again (whatever it was). */
export const offerAnswer = (organize: Organize) => ({ settings: { organize, organizeOffered: true } });

/** Whether the next upload or folder into `library` asks how to sort it: only while it was never answered, here or in Library settings. */
export const offersOrganize = (library: LibrarySummary | null | undefined) => !!library && !library.settings.organize && !library.settings.organizeOffered;

/**
 * The Media Library page's organizing, for its owner. `offer` / `answerOffer`: the first upload or folder asks how the
 * library sorts it (BigUploadDialog), the answer saved before the files come in. `organized`: the library saved, its
 * folders read fresh (a refresh could join a read from before the default folders were made, and the page hears no
 * notice of its own writes).
 */
export function useOrganize({
  library,
  owner,
  onSaved,
  setFolders,
  onError,
}: {
  library: LibrarySummary | null;
  owner: boolean;
  onSaved: (l: LibrarySummary) => void;
  setFolders: (c: Collection[]) => void;
  onError: (e: string) => void;
}): { offer: boolean; answerOffer: (o: Organize) => Promise<void>; organized: (l: LibrarySummary) => Promise<void> } {
  const organized = async (l: LibrarySummary) => {
    onSaved(l);
    setFolders(await listCollections(l.id));
  };
  const offer = owner && offersOrganize(library);
  const answerOffer = async (o: Organize) => {
    if (!offer || !library) return;
    // a failed save never stops the files that wait on it
    await updateLibrary(library.id, offerAnswer(o))
      .then(organized)
      .catch((e) => onError(message(e)));
  };
  return { offer, answerOffer, organized };
}
