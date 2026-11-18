import { useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import { PLACES_MAX, type GoneAnswer, type HereAnswer, type PlacesReportAnswer } from "@contracts/places";
import { Button } from "@/components/ui/button";
import { deviceHere } from "@/lib/onMac";
import { thisMacDevice } from "@/lib/providers";
import { chooseFolderOnMac, importLocate, macImports } from "@/lib/thisMac";

/**
 * Locate… on a clip whose original is gone from where the library has it (api/library/locate.ts): the person picks the
 * folder it is in now, their Mac fingerprints the files of the right sizes there, and every gone file found in it
 * reconnects at once (a teammate's clip: this computer's own way to it). Only in the Mac app: a browser cannot read a folder's paths. A clip on a Mac shows it once
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
    void locatable(libraryId, { versionId, only: "1", device: thisMacDevice() ?? "" })
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

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Connect originals… (the library's More menu): the person picks a folder (a download, an office NAS), this Mac
 * fingerprints its files of the right sizes, and each clip this computer has no place for whose size and fingerprint
 * match becomes this computer's own place (api/library/places.ts, gone?connect=1 and confirmPlaces, which checks the
 * fingerprint again). Of two copies, the one with the clip's name; else neither. How many connected; null when no
 * folder was picked.
 */
export async function connectOriginals(libraryId: string): Promise<number | null> {
  const folder = await chooseFolderOnMac();
  if (!folder) return null;
  const device = (await deviceHere()) ?? "";
  const r = await fetch(`/api/library/${libraryId}/places/gone?${new URLSearchParams({ device, away: "1", connect: "1" })}`);
  if (!r.ok) throw new Error("Could not read the library");
  const { gone } = (await r.json()) as GoneAnswer;
  const found = await importLocate(
    gone.map((g) => ({ id: g.versionId, path: g.path, bytes: g.bytes })),
    folder,
  );
  const confirmed = gone.flatMap((g) => {
    const all = found.files.filter((f) => f.size === g.bytes && f.quick === g.quick);
    const at = all.find((f) => base(f.path) === g.name) ?? (all.length === 1 ? all[0] : undefined);
    return at ? [{ versionId: g.versionId, path: at.path, quick: g.quick }] : [];
  });
  let n = 0;
  for (let i = 0; i < confirmed.length; i += PLACES_MAX) {
    const res = await fetch(`/api/library/${libraryId}/places`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, confirmed: confirmed.slice(i, i + PLACES_MAX) }),
    });
    if (!res.ok) throw new Error("Could not connect the originals");
    n += ((await res.json()) as PlacesReportAnswer).confirmed.length;
  }
  return n;
}

/** This computer's count of the library's originals and the server's proxies (api/library/places.ts here); null outside the Mac app. */
export async function placesHere(libraryId: string): Promise<HereAnswer | null> {
  const device = thisMacDevice() ?? (await deviceHere());
  if (!device) return null;
  const r = await fetch(`/api/library/${libraryId}/places/here?${new URLSearchParams({ device })}`);
  if (!r.ok) throw new Error("Could not read the library");
  return (await r.json()) as HereAnswer;
}
