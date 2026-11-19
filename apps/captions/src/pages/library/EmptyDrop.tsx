import { Upload } from "lucide-react";
import { LIBRARY_WORDS } from "@contracts/library";

/**
 * The empty Media Library (11-19, Andri): the page is one drop box and nothing else. A drop anywhere on the page adds the
 * files (the page's own drop, LibraryDrop.tsx, as New footage says: copied into Source media or used where they are); a
 * click opens the file window (`onChoose`, the page's picker: the Mac app's own panel in the Mac app). Someone who may
 * only look gets one line.
 */
export function EmptyDrop({ canAdd, onChoose }: { canAdd: boolean; onChoose: () => void }) {
  if (!canAdd) return <p className="py-16 text-center text-sm text-zinc-500">{LIBRARY_WORDS.noClipsYet}</p>;
  return (
    <button
      type="button"
      onClick={onChoose}
      className="flex min-h-[60vh] w-full flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-zinc-500/30 text-center outline-none transition-colors hover:border-zinc-500/50 hover:bg-zinc-500/5 focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
    >
      <Upload aria-hidden className="h-8 w-8 text-zinc-400" />
      <span className="text-base font-medium">{LIBRARY_WORDS.dropMedia}</span>
      <span className="text-sm text-zinc-500">{LIBRARY_WORDS.orChooseFiles}</span>
    </button>
  );
}
