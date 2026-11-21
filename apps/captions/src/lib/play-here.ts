// A Review version plays from its own file on this computer when it is here (the Mac app on the computer that rendered
// it), else from the server copy. `local` is the version's path where it was made (managers only, api/review.ts); it is
// the same file the server holds, so nothing plays here that Review wouldn't show this person.

import { useEffect, useState } from "react";
import { localMediaFiles, localMediaUrl, placesState } from "@/lib/local-files";
import { onDisk, type Exists } from "@/lib/relink";

/** The src to play: the local file when the Mac app says it is here (an older app: it answers a one-byte read), else `server`. */
export async function playFrom(server: string, local: string | undefined, said = placesState, exists: Exists = onDisk): Promise<string> {
  if (!local || !localMediaFiles()) return server;
  const s = await said([local]);
  const here = s ? s.states[local] === "here" : await exists(local);
  return here ? localMediaUrl(local) : server;
}

/**
 * A <video>'s src for a Review version (undefined while the Mac app is asked) and its onError: a local file that fails
 * to load falls back to the server copy. `local` may be looked up first (a chat card asks Review for it).
 */
export function usePlayFrom(server: string, local: string | undefined | (() => Promise<string | undefined>)) {
  const ask = !!local && localMediaFiles();
  const [src, setSrc] = useState<string | undefined>(ask ? undefined : server);
  const key = typeof local === "function" ? "lookup" : local;
  useEffect(() => {
    if (!ask) return setSrc(server);
    let live = true;
    setSrc(undefined);
    const path = typeof local === "function" ? local().catch(() => undefined) : Promise.resolve(local);
    void path
      .then((p) => playFrom(server, p))
      .catch(() => server)
      .then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
    // `local` as a lookup is a new function each render: `key` stands for it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, key, ask]);
  return { src, onError: () => setSrc((s) => (s && s !== server ? server : s)) };
}
