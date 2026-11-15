/// <reference lib="webworker" />
import { Sha256 } from "./sha256";

/** A file's SHA-256, read 8 MB at a time off the page's thread (Uploads.tsx alreadyThere): { hex } or { error }. */
self.onmessage = async (e: MessageEvent<File>) => {
  const file = e.data;
  const hash = new Sha256();
  const step = 8 * 1024 * 1024;
  try {
    for (let at = 0; at < file.size; at += step) hash.update(new Uint8Array(await file.slice(at, at + step).arrayBuffer()));
    self.postMessage({ hex: hash.digest() });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
