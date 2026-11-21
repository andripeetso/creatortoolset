// Every player's one rule for where a file plays: from this computer when the Mac app has it here, else from the server.
// `local` is either the file's absolute path on the computer that made it (a Review version's `local`, an AI Editor
// draft's render), which the Mac app is asked about, or a ctlocal:// URL the Mac app already found here by its own rules
// (a library version's places answer, lib/here.ts). A path plays here only when the server would serve this person the
// same file (one byte is asked for), so nothing plays locally that the server keeps from them (Blur faces, say).

import { useEffect, useState } from "react";
import { localMediaFiles, localMediaUrl, placesState } from "@/lib/local-files";
import { onDisk, type Exists } from "@/lib/relink";
import { macPlaces } from "@/lib/thisMac";

/** Whether the server serves `url` to this person: a one-byte read answered, or sent on elsewhere (a signed link). */
export async function servedTo(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "manual" });
    void r.body?.cancel();
    return r.ok || r.type === "opaqueredirect";
  } catch {
    return false;
  }
}

/** The src to play: the Mac app's own URL, or the local path's when the Mac app says it is here (an older app: it answers a
 *  one-byte read) and the server serves it to this person; else `server`. */
export async function playFrom(server: string, local: string | undefined, said = placesState, exists: Exists = onDisk, serves = servedTo): Promise<string> {
  if (!local) return server;
  if (local.startsWith("ctlocal:")) return local;
  if (!localMediaFiles()) return server;
  const [s, ok] = await Promise.all([said([local]), serves(server)]);
  if (!ok) return server;
  const here = s ? s.states[local] === "here" : await exists(local);
  return here ? localMediaUrl(local) : server;
}

/**
 * A <video>'s src (undefined while the Mac app is asked) and its onError: a local file that fails to load falls back to
 * the server copy. `local` may be looked up first (a chat card asks Review for it). Outside the Mac app: `server` at once.
 */
export function usePlayFrom(server: string, local: string | undefined | (() => Promise<string | undefined>)) {
  const ask = !!local && (localMediaFiles() || macPlaces());
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
