import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { chooseFolderOnMac } from "@/lib/thisMac";

/**
 * "Where are your videos?": shown by the Media Library and the AI Editor while the account has no footage folder yet.
 * The folder the person picks goes on the Library's watch list (api/library/watch.ts), which imports it in place: nothing
 * is walked, copied or uploaded. Choose a folder opens the Mac app's own folder picker; in a browser on the person's
 * computer it asks for a path, which the server checks. On a hosted server the card offers upload instead.
 * Skip is remembered in this browser; the card goes for good once a folder exists.
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

export function FootageFolderCard({ libraryId, onUpload }: { libraryId: string; onUpload?: () => void }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [skipped, setSkipped] = useState(skippedBefore);
  const [added, setAdded] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (skipped) return;
    let live = true;
    fetch(`/api/library/${libraryId}/watch`)
      .then((r) => (r.ok ? (r.json() as Promise<WatchStatus>) : null))
      .then((s) => live && setStatus(s))
      .catch(() => undefined); // no answer: no card
    return () => {
      live = false;
    };
  }, [libraryId, skipped]);

  if (skipped || added || !status || status.folders.length > 0) return null;

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
      setAdded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that folder. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const picked = await chooseFolderOnMac();
    if (picked === undefined) setTyping(true); // a browser: no folder picker, so a path is typed
    else if (picked) await add(picked); // null: the person cancelled the Mac's panel
  };

  const skip = () => {
    rememberSkip();
    setSkipped(true);
  };

  if (!status.allowed) {
    return (
      <section aria-label="Footage folder" className="flex flex-col gap-3 rounded-xl border border-zinc-500/20 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Where are your videos?</h2>
          <p className="text-sm text-zinc-500">
            Your videos are on your computer. Upload them here, or use the Creator Toolset Mac app to read a folder on your computer.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => (onUpload ? onUpload() : navigate("/library"))}>
            Upload files
          </Button>
          <Button variant="ghost" size="sm" onClick={skip}>
            Skip
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Footage folder" className="flex flex-col gap-3 rounded-xl border border-zinc-500/20 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Where are your videos?</h2>
        <p className="text-sm text-zinc-500">Creator Toolset reads the folder you pick, where it is. Nothing is moved or uploaded.</p>
      </div>
      {typing && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void add(path.trim());
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
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void choose()}>
          Choose a folder
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={skip}>
          Skip
        </Button>
      </div>
    </section>
  );
}
