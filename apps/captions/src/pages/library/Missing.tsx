import { useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import type { PlaceMove, PlacesSearchState } from "@contracts/places";
import { Button } from "@/components/ui/button";
import { placeMoves } from "@/lib/library";
import { macSearch, placesSearch, placesSearchState } from "@/lib/thisMac";

/**
 * Under the Missing here filter in the Media Library's sidebar: Find missing files on this Mac (apps/mac
 * PlacesSearch.swift) with how far it is, and what moved or was found elsewhere lately, one line per folder change
 * (api/library/places.ts). This Mac also starts a search by itself after it finds files gone; this shows that one too.
 */

const files = (n: number) => `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;
const last = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** One line per folder change: "Moved: 2025 → Archive/2025 (48 files)", "Found on Travel SSD (12 files)". */
export function moveLine(m: PlaceMove): string {
  if (m.kind === "found") return `Found on ${m.root?.name ?? last(m.to)} (${files(m.count)})`;
  const top = m.root?.name ?? "the top";
  return `Moved: ${m.from || top} → ${m.to || top} (${files(m.count)})`;
}

/** How far a search is, or what it found; null when there is nothing to say. */
export function searchLine(s: PlacesSearchState | null): string | null {
  if (!s) return null;
  if (s.running) return [s.left ? `Looking for ${files(s.left)}` : "Looking", s.found ? `${s.found.toLocaleString()} found` : ""].filter(Boolean).join(" · ");
  return [s.found ? `Found ${files(s.found)}` : "", s.left ? `${files(s.left)} not found` : ""].filter(Boolean).join(" · ") || null;
}

export function Missing({ libraryId }: { libraryId: string }) {
  const can = macSearch();
  const [state, setState] = useState<PlacesSearchState | null>(null);
  const [failed, setFailed] = useState(false);
  const [moves, setMoves] = useState<PlaceMove[]>([]);
  const [asked, setAsked] = useState(0);
  const running = !!state?.running;

  // this Mac's search, every second while it runs
  useEffect(() => {
    if (!can) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      void placesSearchState().then(
        (s) => {
          if (!live) return;
          setState(s);
          if (s.running) timer = setTimeout(tick, 1000);
        },
        () => undefined,
      );
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [can, asked]);

  // what moved: on opening, and again when a search ends
  useEffect(() => {
    if (running) return;
    let live = true;
    placeMoves(libraryId).then(
      (m) => live && setMoves(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [libraryId, running]);

  const find = () => {
    setFailed(false);
    void placesSearch(libraryId).then(
      (s) => {
        setState(s);
        setAsked((n) => n + 1);
      },
      () => setFailed(true),
    );
  };

  const line = failed ? "Could not look for missing files" : state?.library === libraryId ? searchLine(state) : running ? "Looking in another library" : null;
  if (!can && !moves.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {can && (
        <Button size="sm" variant="outline" className="h-7 w-fit gap-1.5 px-2.5 text-[12px]" disabled={running} onClick={find}>
          <FolderSearch aria-hidden className="h-3.5 w-3.5" />
          Find missing files
        </Button>
      )}
      {line && (
        <p role="status" className="text-[12px] text-zinc-500">
          {line}
        </p>
      )}
      {moves.length > 0 && (
        <ul aria-label="Moved and found" className="flex flex-col gap-1 text-[12px] text-zinc-400">
          {moves.slice(0, 10).map((m) => (
            <li key={`${m.kind}|${m.root?.key ?? ""}|${m.from}|${m.to}`} className="break-words">
              {moveLine(m)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
