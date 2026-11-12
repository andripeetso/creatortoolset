import { useState } from "react";
import { useNavigate } from "react-router";
import type { WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getWatch } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { chooseFolderOnMac } from "@/lib/thisMac";
import { cn } from "@/lib/utils";
import { BIG_DROP, BigUploadDialog, dropOf, type FolderSize } from "@/components/LibraryProcessing";

/**
 * "Where are your videos?": shown by the Media Library and the AI Editor while the account has no footage folder yet.
 * The folder the person picks goes on the Library's watch list (api/library/watch.ts), which imports it in place: nothing
 * is walked, copied or uploaded. Choose a folder opens the Mac app's own folder picker; in a browser on the person's
 * computer it asks for a path, which the server checks. On a hosted server the card offers upload instead.
 * Skip is remembered in this browser; the card goes for good once a folder exists. `page`: the Media Library's own first
 * screen (an empty library), centred, with what the library is for and upload as the second way; no Skip there.
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

export function FootageFolderCard({ libraryId, onUpload, page = false }: { libraryId: string; onUpload?: () => void; page?: boolean }) {
  const navigate = useNavigate();
  const [skipped, setSkipped] = useState(() => !page && skippedBefore());
  // the saved watch status (the same copy as the Library's watch folders), so the card is in place on the first frame
  const live = useCachedLoad<WatchStatus>(skipped ? null : `/api/library/${libraryId}/watch`, () => getWatch(libraryId));
  const status = live.data;
  const [added, setAdded] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ folder: string; size: FolderSize } | null>(null); // a big folder, waiting for its go
  const [error, setError] = useState<string | null>(null);

  // the first screen stays until the page has the folder (then the page itself moves on to the clips coming in)
  if (skipped || (added && !page) || status?.folders.length) return null;
  // no status: still being read, or not this account's to see (only the owner gets one); the library's own first
  // screen then offers upload, the way a hosted server does
  if (!status && !(page && live.error)) return null;
  const folderless = !status?.allowed;

  const add = async (folder: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/library/watch/folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folder, libraryId }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? `Couldn't add that folder (${r.status})`);
      // the shared saved status at once, read fresh (a refresh could join a read from before the folder was added): the
      // Library page goes straight to the clips coming in
      const fresh = await getWatch(libraryId).catch(() => null);
      if (fresh) live.set(fresh);
      setAdded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that folder. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // a big folder says first what importing it takes; a size the server can't read adds the folder as before
  const check = async (folder: string) => {
    const r = await fetch(`/api/library/${libraryId}/watch/size?path=${encodeURIComponent(folder)}`).catch(() => null);
    const size = r?.ok ? ((await r.json()) as FolderSize) : null;
    if (size && size.files >= BIG_DROP) setAsking({ folder, size });
    else await add(folder);
  };

  const choose = async () => {
    const picked = await chooseFolderOnMac();
    if (picked === undefined) setTyping(true); // a browser: no folder picker, so a path is typed
    else if (picked) await check(picked); // null: the person cancelled the Mac's panel
  };

  const dialog = asking && (
    <BigUploadDialog
      libraryId={libraryId}
      drop={dropOf(asking.size)}
      title={`Add ${asking.size.files.toLocaleString()} clips from this folder?`}
      go="Add folder"
      onClose={() => setAsking(null)}
      onUpload={() => {
        void add(asking.folder);
        setAsking(null);
      }}
    />
  );

  const skip = () => {
    rememberSkip();
    setSkipped(true);
  };

  const box = page
    ? "mx-auto flex w-full max-w-md flex-col items-center gap-5 py-16 text-center sm:py-24"
    : "flex flex-col gap-3 rounded-xl border border-zinc-500/20 p-4";
  const heading = <h2 className={page ? "text-xl font-semibold" : "text-sm font-medium"}>Where are your videos?</h2>;
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
          {page && <p className="text-sm text-zinc-500">This is where you keep your raw materials: the clips you reuse across videos.</p>}
          {status && (
            <p className="text-sm text-zinc-500">
              Your videos are on your computer. Upload them here, or use the Creator Toolset Mac app to read a folder on your computer.
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
            ? "This is where you keep your raw materials: the clips you reuse across videos. You choose the folder they are in, and nothing is moved."
            : "Creator Toolset reads the folder you pick, where it is. Nothing is moved."}
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
            placeholder="~/Movies/Trip"
            aria-label="Folder path"
            className="min-w-0 flex-1 basis-60 font-mono"
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !path.trim()}>
            Check folder
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
        {page && onUpload && (
          <Button variant="outline" size={page ? "default" : "sm"} disabled={busy} onClick={onUpload}>
            Upload files
          </Button>
        )}
        {skipButton}
      </div>
      {dialog}
    </section>
  );
}
