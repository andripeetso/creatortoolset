import { useState } from "react";
import { useNavigate } from "react-router";
import type { Organize, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getWatch } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { chooseFolderOnMac } from "@/lib/thisMac";
import { cn } from "@/lib/utils";
import { useBigFolder } from "@/components/LibraryProcessing";

/**
 * "Where are your videos?": shown by the Media Library and the AI Editor while the account has no footage folder yet.
 * The folder the person picks goes on the Library's watch list (api/library/watch.ts), read where it is or first copied
 * into the Library's Footage folder on this computer, as they choose in the one dialog that opens (useBigFolder offerCopy;
 * the card's words promise neither). Choose a folder opens the Mac app's own folder picker; in a browser on the person's
 * computer it asks for a path, which the server checks. On a hosted server the card offers upload instead.
 * Skip is remembered in this browser; the card goes for good once a folder exists. `page`: in the Media Library's own
 * page while it holds nothing (below its folders), with what the library is for; no heading and no Skip there, and
 * upload only where no folder can be read (the page's own Upload button is the other way). `offer`: a big folder offers the AI organizing the library (`onOffer` with the answer); without `onOffer` the dialog asks the library itself, as on the AI Editor's page.
 */

const SKIP_KEY = "ct-footage-folder-skipped";

const skippedBefore = (): boolean => {
  try {
    return localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false; // no storage (a private window): the card comes back next time
  }
};

const rememberSkip = () => {
  try {
    localStorage.setItem(SKIP_KEY, "1");
  } catch {
    // no storage: nothing to remember
  }
};

export function FootageFolderCard({
  libraryId,
  onUpload,
  page = false,
  offer = false,
  onOffer,
}: {
  libraryId: string;
  onUpload?: () => void;
  page?: boolean;
  offer?: boolean;
  onOffer?: (o: Organize) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [skipped, setSkipped] = useState(() => !page && skippedBefore());
  // the saved watch status (the same copy as the Library's watch folders), so the card is in place on the first frame
  const live = useCachedLoad<WatchStatus>(skipped ? null : `/api/library/${libraryId}/watch`, () => getWatch(libraryId));
  const status = live.data;
  const [added, setAdded] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const big = useBigFolder(); // where its files are kept, and for a big folder what adding it takes
  const [error, setError] = useState<string | null>(null);

  // the first screen stays until the page has the folder (then the page itself moves on to the clips coming in)
  if (skipped || (added && !page) || status?.folders.length) return null;
  // no status: still being read, or not this account's to see (only the owner gets one); the library's own first
  // screen then offers upload, the way a hosted server does
  if (!status && !(page && live.error)) return null;
  const folderless = !status?.allowed;

  const add = async (folder: string, copyTo?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/library/watch/folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folder, libraryId, copyTo }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? "Could not add the folder");
      // the shared saved status at once, read fresh (a refresh could join a read from before the folder was added): the
      // Library page goes straight to the clips coming in
      const fresh = await getWatch(libraryId).catch(() => null);
      if (fresh) live.set(fresh);
      setAdded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the folder");
    } finally {
      setBusy(false);
    }
  };

  // where its files are kept, and for a big folder what importing it takes; a size the server can't read adds the folder as before
  const check = (folder: string) => big.check(folder, (copyTo) => add(folder, copyTo), { libraryId, ...(onOffer ? { organize: { offer, answer: onOffer } } : {}) });

  const choose = async () => {
    const picked = await chooseFolderOnMac();
    if (picked === undefined) setTyping(true); // a browser: no folder picker, so a path is typed
    else if (picked) await check(picked); // null: the person cancelled the Mac's panel
  };

  const dialog = big.dialog;

  const skip = () => {
    rememberSkip();
    setSkipped(true);
  };

  const box = page
    ? "mx-auto flex w-full max-w-md flex-col items-center gap-5 py-10 text-center sm:py-14"
    : "flex flex-col gap-3 rounded-xl border border-zinc-500/20 p-4";
  const heading = !page && <h2 className="text-sm font-medium">Where are your videos?</h2>;
  const skipButton = !page && (
    <Button variant="ghost" size="sm" onClick={skip}>
      Skip
    </Button>
  );

  if (folderless) {
    return (
      <section aria-label="Footage folder" className={box}>
        <div className="flex flex-col gap-1.5">
          {heading}
          {page && <p className="text-sm text-zinc-500">No clips</p>}
          {status && (
            <p className="text-sm text-zinc-500">
              Reading a folder needs the Mac app.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size={page ? "default" : "sm"} onClick={() => (onUpload ? onUpload() : navigate("/library"))}>
            Upload files
          </Button>
          {skipButton}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Footage folder" className={box}>
      <div className="flex flex-col gap-1.5">
        {heading}
        <p className="text-sm text-zinc-500">
          {page
            ? "No clips"
            : "Creator Toolset reads the folder you pick."}
        </p>
      </div>
      {typing && (
        <form
          className={cn("flex w-full flex-wrap items-center gap-2", page && "justify-center")}
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void check(path.trim());
          }}
        >
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Folder path"
            aria-label="Folder path"
            className="min-w-0 flex-1 basis-60 font-mono"
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !path.trim()}>
            Add folder
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setTyping(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className={cn("flex flex-wrap items-center gap-2", page && "justify-center")}>
        {!(page && typing) && (
          <Button size={page ? "default" : "sm"} disabled={busy} onClick={() => void choose()}>
            Choose a folder
          </Button>
        )}
        {skipButton}
      </div>
      {dialog}
    </section>
  );
}
