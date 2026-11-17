/**
 * Whether this server takes a file's bytes into a library: the one rule, asked by every upload route (the route table is
 * upload-gate.test.ts). A library's Upload setting (none / proxies / all) says what its computers send. Bytes a person
 * chose to send (a browser upload, the phone's Upload) are taken under any setting: the upload is the choice. Bytes a
 * computer would send of a file it holds (an upload naming where the file is on that computer) are taken only where the
 * setting sends originals; under none the file is indexed where it is and nothing is sent. On This Mac the server and the
 * computer are one, so its own files are always taken.
 */
import { finalsUpload, isFinalsCollection, libraryUpload } from "./db";
import { serverKind } from "../work/server-work";

/** original: the file itself; proxy: a smaller copy made of it; derivative: a picture, sheet or text the Library shows; serving: bytes the server made. */
export type ReceiveKind = "original" | "proxy" | "derivative" | "serving";
/** person: someone chose to send it; computer: a computer sends a file it holds, nobody sent it by hand. */
export type ReceiveOrigin = "person" | "computer";

export const REFUSED_NONE = "This library keeps its files on your computers. Add them from the Mac app, or from the computer that has them.";

export type Received = { ok: true } | { ok: false; status: 409; body: { error: string; code: "upload_refused"; message: string } };

export function mayReceive(kind: ReceiveKind, library: { id: string; collectionId?: string | null }, origin: ReceiveOrigin): Received {
  if (kind !== "original" || origin === "person" || serverKind() === "local") return { ok: true };
  const upload = library.collectionId && isFinalsCollection(library.collectionId) ? finalsUpload(library.id) : libraryUpload(library.id);
  // ponytail: proxies still takes a computer's original (its proxy is made here, then dropOriginal); the proxy proof that
  // lets proxies refuse originals comes with the computer-made proxy (local-first plan P2)
  if (upload !== "none") return { ok: true };
  return { ok: false, status: 409, body: { error: REFUSED_NONE, code: "upload_refused", message: REFUSED_NONE } };
}
