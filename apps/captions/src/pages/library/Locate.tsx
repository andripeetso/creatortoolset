import { useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deviceHere } from "@/lib/onMac";
import { chooseFolderOnMac, importLocate, macImports } from "@/lib/thisMac";

/**
 * Locate… on a clip whose original is gone from where the library has it (api/library/locate.ts): the person picks the
 * folder it is in now, their Mac fingerprints the files of the right sizes there, and every gone file of theirs found in
 * it reconnects at once. Only in the Mac app: a browser cannot read a folder's paths. A clip on a Mac shows it once
 * that Mac says the file is not where the library has it; a clip missing from this server's disk shows it at once.
 */

type Locatable = { id: string; path: string; bytes: number };

async function locatable(libraryId: string, q: Record<string, string>): Promise<Locatable[]> {
  const r = await fetch(`/api/library/${libraryId}/locate?${new URLSearchParams(q)}`);
  if (!r.ok) return [];
  return ((await r.json()) as { files: Locatable[] }).files;
}

export function Locate({ libraryId, versionId, missing, onMac }: { libraryId: string; versionId: string; missing: boolean; onMac: boolean }) {
  const [gone, setGone] = useState(missing);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const here = macImports();

  useEffect(() => {
    setGone(missing);
    setSaid(null);
    if (!here || missing || !onMac) return;
    let live = true;
    void locatable(libraryId, { versionId, only: "1" })
      .then((files) => (files.length ? importLocate(files) : null))
      .then((r) => live && r && setGone(r.gone.includes(versionId)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [here, libraryId, versionId, missing, onMac]);

  if (!here || !gone) return null;

  const locate = async () => {
    const folder = await chooseFolderOnMac();
    if (!folder) return;
    setBusy(true);
    setSaid(null);
    try {
      const device = (await deviceHere()) ?? "";
      const files = await locatable(libraryId, { versionId, device });
      const found = await importLocate(files, folder);
      const r = await fetch(`/api/library/${libraryId}/locate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId, device: device || undefined, gone: found.gone, files: found.files }),
      });
      const body = (await r.json().catch(() => ({}))) as { reconnected?: number; error?: string };
      if (!r.ok) throw new Error(body.error ?? "Could not locate the file");
      const n = body.reconnected ?? 0;
      setSaid(n ? `${n} ${n === 1 ? "file" : "files"} found` : "No matching files in that folder");
    } catch (e) {
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void locate()}>
        <FolderSearch className="h-4 w-4" />
        Locate…
      </Button>
      {said && <span className="text-xs text-muted-foreground">{said}</span>}
    </div>
  );
}
