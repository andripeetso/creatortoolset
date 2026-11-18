// What plays a clip whose original is on a computer (contracts/places.ts): the original from this computer when the Mac
// app finds it here, else a proxy (this computer's cached one, else the server's). A page without the Mac app's mark
// (`data-mac-places`) asks nothing and plays the server's proxy, as before.

import { useCallback, useEffect, useRef, useState } from "react";
import { PLACES_MAX, type PlaceCheck, type RootLabel } from "@contracts/places";
import { macPlaces, placesCheck } from "@/lib/thisMac";

/** Each version's answer from this computer; a version it said nothing about is left out. */
export type Here = Record<string, PlaceCheck>;

export type Source = { src: string; badge: "Original" | "Proxy" };

/**
 * What plays a version, from this computer's answer (none: nothing found here, the server's proxy). `serverPlays` false
 * (the library's Upload is none and no team shares it): the server plays nothing, so a version this computer lacks has no src.
 */
export function pickSource(check: PlaceCheck | undefined, versionId: string, serverPlays = true): Source {
  if (check?.state === "here" && check.url) return { src: check.url, badge: "Original" };
  return proxySource(check, versionId, serverPlays);
}

/** The proxy that plays a version: this computer's cached one (Available offline, plays without internet), else the server's. */
export function proxySource(check: PlaceCheck | undefined, versionId: string, serverPlays = true): Source {
  const cached = check?.state === "cached" ? check.url : check?.cached;
  return { src: cached ?? (serverPlays ? `/api/library/media/${versionId}/play` : ""), badge: "Proxy" };
}

/** "footage (office-nas)": a root as the lines under a player name it. */
export const rootName = (r: RootLabel) => (r.server ? `${r.name} (${r.server})` : r.name);

/** Why the original doesn't play here, in one line (none when it does, or nothing was said). */
export function awayLine(check: PlaceCheck | undefined): string | null {
  if (check?.state === "away") return check.root ? `The original is on ${rootName(check.root)}, which isn't connected` : "The original's disk isn't connected";
  if (check?.state === "gone") return "The original is missing on this computer";
  return null;
}

/** The longest the page waits for the Mac's answer before it plays the server's proxy. */
const WAIT_MS = 5000;

/** Every version's answer, from each library in turn (the first that knows it), PLACES_MAX at a time. */
async function check(libraries: string[], ids: string[]): Promise<Here> {
  const asks: Promise<Here>[] = [];
  for (const library of libraries)
    for (let i = 0; i < ids.length; i += PLACES_MAX) {
      const ask = placesCheck({ library, versions: ids.slice(i, i + PLACES_MAX) }).catch(() => ({}));
      asks.push(Promise.race([ask, new Promise<Here>((r) => setTimeout(() => r({}), WAIT_MS))]));
    }
  const out: Here = {};
  for (const got of await Promise.all(asks)) for (const [id, c] of Object.entries(got)) out[id] ??= c;
  return out;
}

/**
 * This computer's answer for each of `ids` in `library` (or in each of several: Review's edit may use clips of more than
 * one), asked again on the Mac app's `mac-places` event (a disk came or went), when the window comes back to the front,
 * and by `again()` (after a button pressed). null until the first answer, and always without the Mac app's mark. An
 * answer for ids or a library asked before is dropped.
 * ponytail: the clip window and Review only; the grid keeps the server's mark (a live check per card would be one ask per 200 cards)
 */
export function useHere(library: string | string[] | null, ids: string[]): [Here | null, () => Promise<Here>] {
  const libraries = library === null ? [] : [library].flat();
  const key = macPlaces() && libraries.length && ids.length ? JSON.stringify([libraries, ids]) : "";
  const [got, setGot] = useState<{ key: string; here: Here } | null>(null);
  const turn = useRef(0);
  const again = useCallback(async () => {
    if (!key) return {};
    const n = ++turn.current;
    const [libs, versions] = JSON.parse(key) as [string[], string[]];
    const here = await check(libs, versions);
    if (n === turn.current) setGot({ key, here });
    return here;
  }, [key]);
  useEffect(() => {
    if (!key) return;
    const ask = () => void again();
    ask();
    window.addEventListener("mac-places", ask);
    window.addEventListener("focus", ask);
    return () => {
      turn.current++;
      window.removeEventListener("mac-places", ask);
      window.removeEventListener("focus", ask);
    };
  }, [key, again]);
  return [got?.key === key && key ? got.here : null, again];
}
