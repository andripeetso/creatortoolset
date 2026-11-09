import path from "node:path";
import { phashPerSecond } from "../../library/fingerprint";
import { NeedsKey, transcribeFile } from "../../library/transcribe";
import { speechWords } from "../../library/similar";
import { env } from "../env";
import { findAccount, patchAccount } from "./store";

/**
 * Fingerprints and speech of the posted videos a login gives a media URL for (Instagram's own reels): each post's
 * per-second pHashes, the same method as the library's, and its words, for the voice check. Run after a pull, while
 * the URLs are fresh; ffmpeg reads the URL directly, nothing is saved to disk. A post that can't be read is kept as an
 * empty list, so it is not tried again. Speech needs the user's Deepgram (or OpenAI) key: without one it is left
 * unset, so a later pull with a key fills it.
 */

const running = new Set<string>();

/** A post's speech: the words its video says, read with the user's own transcription key (NeedsKey without one). */
export async function speechOf(src: string, user: string): Promise<string[]> {
  const { words } = await transcribeFile(src, user, path.join(env.dataDir, "library", "scratch"));
  return speechWords(words.map((w) => w.w));
}

/** Fingerprint the account's posts that have a media URL and no print yet, and transcribe those with no speech yet. Returns how many prints were tried. */
export async function printPosts(
  user: string,
  key: string,
  hash: (src: string) => Promise<string[]> = phashPerSecond,
  speak: (src: string, user: string) => Promise<string[]> = speechOf,
): Promise<number> {
  const guard = `${user}/${key}`;
  if (running.has(guard)) return 0;
  running.add(guard);
  let tried = 0;
  try {
    for (const p of findAccount(user, key)?.posts ?? []) {
      if (!p.mediaUrl) continue;
      if (!findAccount(user, key)?.prints?.[p.id]) {
        const pHashes = await hash(p.mediaUrl).catch(() => []);
        // read the stored prints again each time: the account may have been pulled or removed meanwhile
        const cur = findAccount(user, key);
        if (!cur) break;
        patchAccount(user, key, { prints: { ...cur.prints, [p.id]: pHashes } });
        tried++;
      }
      if (findAccount(user, key)?.voices?.[p.id] === undefined) {
        let words: string[];
        try {
          words = await speak(p.mediaUrl, user);
        } catch (e) {
          if (e instanceof NeedsKey) continue; // no key: left unset, a later pull with a key fills it
          words = [];
        }
        const cur = findAccount(user, key);
        if (!cur) break;
        patchAccount(user, key, { voices: { ...cur.voices, [p.id]: words } });
      }
    }
  } finally {
    running.delete(guard);
  }
  return tried;
}
