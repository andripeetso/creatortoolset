import { LIBRARY_WORDS } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { CantRead, type WaitingFolders } from "./Import";

/**
 * The empty Media Library (11-19 sign-off C1): a small dashed box in the middle of the page, with a drawing of what the Library holds
 * (a photo, a video, sound) in the workspace colour, "Drop media here" and Choose files. A drop anywhere on the page adds
 * the files (the page's own drop, LibraryDrop.tsx, as New footage says: copied into Source media or used where they are);
 * Choose files opens the file window (`onChoose`, the page's picker: the Mac app's own panel in the Mac app). Someone who
 * may only look gets one line. A Media folder that waits for its Mac's OK is the page's one thing instead (CantRead): its
 * files come in once it is allowed, so dropping more is not the next step.
 */
export function EmptyDrop({ canAdd, onChoose, waiting }: { canAdd: boolean; onChoose: () => void; waiting?: WaitingFolders }) {
  if (waiting?.waiting.length) return <CantRead {...waiting} centred />;
  if (!canAdd) return <p className="py-16 text-center text-sm text-zinc-500">{LIBRARY_WORDS.noClipsYet}</p>;
  return (
    // the page centres it below the top bar; half a bar up puts it in the middle of the window
    <div className="m-auto flex w-full max-w-md -translate-y-[calc(var(--bar-h)/2)] flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-zinc-500/30 bg-background px-6 py-7 text-center">
      <MediaDrawing />
      <span className="text-base font-medium">{LIBRARY_WORDS.dropMedia}</span>
      <Button size="sm" variant="outline" className="mt-1" onClick={onChoose}>
        {LIBRARY_WORDS.chooseFiles}
      </Button>
    </div>
  );
}

/** A photo, a video frame and a sound card, fanned, in the workspace colour (decoration, read by no one). */
function MediaDrawing() {
  return (
    <svg aria-hidden viewBox="0 0 132 96" className="mb-1 h-24 w-32 text-violet-600">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
        <g transform="rotate(-12 34 44)">
          <rect x="12" y="22" width="44" height="40" rx="5" className="fill-violet-600/10" />
          <circle cx="24" cy="34" r="4" />
          <path d="M14 58l13-13 9 9 6-6 12 12" />
        </g>
        <g transform="rotate(10 98 44)">
          <rect x="76" y="22" width="44" height="40" rx="5" className="fill-violet-600/10" />
          <path d="M84 46h4l3-8 4 16 4-12 3 6 3-2h7" />
        </g>
        <rect x="42" y="12" width="48" height="44" rx="6" className="fill-background" />
        <rect x="42" y="12" width="48" height="44" rx="6" className="fill-violet-600/15" />
        <path d="M42 20h48M42 48h48M50 12v8M58 12v8M66 12v8M74 12v8M82 12v8M50 48v8M58 48v8M66 48v8M74 48v8M82 48v8" />
        <path d="M62 28l9 6-9 6z" fill="currentColor" />
        <path d="M30 80h72" strokeDasharray="3 4" opacity="0.5" />
      </g>
    </svg>
  );
}
