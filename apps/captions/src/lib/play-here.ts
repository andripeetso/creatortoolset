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

/** A local file as a player names it: its path, and with a Review version its size, since a later render can take that path. */
export type Local = string | { path: string; bytes: number };

/** The size of the file at a ctlocal:// URL, from the Mac app's answer to a one-byte read (Content-Range); null when it doesn't play. */
export async function localBytes(url: string): Promise<number | null> {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    void r.body?.cancel();
    const total = /\/(\d+)$/.exec(r.headers.get("content-range") ?? "")?.[1];
    return r.status === 206 && total ? Number(total) : null;
  } catch {
    return null;
  }
}

/** The src to play: the Mac app's own URL, or the local path's when the Mac app says it is here (an older app: it answers a
 *  one-byte read; a path with its size: the file there is that size) and the server serves it to this person; else `server`. */
export async function playFrom(
  server: string,
  local: Local | undefined,
  { said = placesState, exists = onDisk as Exists, serves = servedTo, size = localBytes } = {},
): Promise<string> {
  if (!local) return server;
  if (typeof local === "string" && local.startsWith("ctlocal:")) return local;
  if (!localMediaFiles()) return server;
  const path = typeof local === "string" ? local : local.path;
  // a version's own file only: a re-render at the same path that Review never filed as a newer version is another size
  // the Mac app's quick answer first (a drive that stopped answering is away within seconds), then the size read
  const here = (await isHere(path, said, exists)) && (typeof local === "string" || (await size(localMediaUrl(path))) === local.bytes);
  return here && (await serves(server)) ? localMediaUrl(path) : server;
}

async function isHere(path: string, said: typeof placesState, exists: Exists): Promise<boolean> {
  const s = await said([path]);
  return s ? s.states[path] === "here" : exists(path);
}

/**
 * A <video>'s src (undefined while the Mac app is asked) and its onError: a local file that fails to load falls back to
 * the server copy. `local` may be looked up first (a chat card asks Review for it). Outside the Mac app: `server` at once.
 */
export function usePlayFrom(server: string, local: Local | undefined | (() => Promise<Local | undefined>)) {
  const ask = !!local && (localMediaFiles() || macPlaces());
  const named = typeof local === "function" ? "lookup" : typeof local === "object" ? `${local.path}\n${local.bytes}` : (local ?? "");
  const key = `${server}\n${named}\n${ask}`;
  // the src kept with the inputs it was picked for, so a new file never starts loading the last one's
  const [got, setGot] = useState<{ key: string; src: string }>();
  useEffect(() => {
    if (!ask) return;
    let live = true;
    const path = typeof local === "function" ? local().catch(() => undefined) : Promise.resolve(local);
    void path
      .then((p) => playFrom(server, p))
      .catch(() => server)
      .then((src) => live && setGot({ key, src }));
    return () => {
      live = false;
    };
    // `local` as a lookup is a new function each render: `key` stands for it and `server`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const src = !ask ? server : got?.key === key ? got.src : undefined;
  return { src, onError: () => src && src !== server && setGot({ key, src: server }) };
}
