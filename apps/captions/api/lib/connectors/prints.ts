import path from "node:path";
import { NeedsKey, transcribeFile, transcribeRoute } from "../../library/transcribe";
import { speechWords } from "../../library/similar";
import { startTask } from "../../work/tasks";
import { env } from "../env";
import { findAccount, patchAccount } from "./store";

/**
 * Fingerprints and speech of the posted videos a login gives a media URL for (Instagram's own reels): each post's
 * per-second pHashes, the same method as the library's, and its words, for the voice check. Started after a pull, while
 * the URLs are fresh; the `posted-prints` computer task (work/tasks/social-prints.ts) reads each URL directly, nothing of
 * the video is kept. A post that can't be read is kept as an empty list, so it is not tried again. Speech needs the
 * user's Deepgram (or OpenAI) key: without one it is left unset, so a later pull with a key fills it.
 */

export interface PrintsInput {
  user: string;
  key: string;
  posts: Array<{ id: string; url: string; print: boolean; voice: boolean }>;
}

const running = new Set<string>();

/** A post's speech: the words of its sound (cut by the task), read with the user's own transcription key (NeedsKey without one). */
export async function speechOf(src: string, user: string): Promise<string[]> {
  const { words } = await transcribeFile(src, user, path.join(env.dataDir, "library", "scratch"));
  return speechWords(words.map((w) => w.w));
}

/** Hands the account's posts that have a media URL and no print yet (or no speech yet, with a key) to the task. Returns how many prints were asked for. */
export async function printPosts(user: string, key: string): Promise<number> {
  const guard = `${user}/${key}`;
  if (running.has(guard)) return 0;
  running.add(guard);
  try {
    const a = findAccount(user, key);
    let voice = true;
    try {
      transcribeRoute(user);
    } catch (e) {
      if (!(e instanceof NeedsKey)) throw e;
      voice = false; // no key: left unset, a later pull with a key fills it
    }
    const posts = (a?.posts ?? []).flatMap((p) => {
      if (!p.mediaUrl) return [];
      const ask = { id: p.id, url: p.mediaUrl, print: !a?.prints?.[p.id], voice: voice && a?.voices?.[p.id] === undefined };
      return ask.print || ask.voice ? [ask] : [];
    });
    if (!posts.length) return 0;
    await startTask<PrintsInput, unknown>("posted-prints", guard, user, null, { user, key, posts });
    return posts.filter((p) => p.print).length;
  } finally {
    running.delete(guard);
  }
}

/** The task's result filed on the account: the prints, then each sound heard (`sounds`: post id → its sound file). */
export async function filePrints(input: PrintsInput, prints: Record<string, string[]>, sounds: Record<string, string>, speak: (src: string, user: string) => Promise<string[]> = speechOf): Promise<void> {
  const { user, key } = input;
  // read the stored prints again each time: the account may have been pulled or removed meanwhile
  const cur = findAccount(user, key);
  if (!cur) return;
  if (Object.keys(prints).length) patchAccount(user, key, { prints: { ...cur.prints, ...prints } });
  for (const p of input.posts) {
    if (!p.voice) continue;
    let words: string[];
    try {
      words = sounds[p.id] ? await speak(sounds[p.id]!, user) : [];
    } catch (e) {
      if (e instanceof NeedsKey) continue; // no key: left unset, a later pull with a key fills it
      words = [];
    }
    const now = findAccount(user, key);
    if (!now) break;
    patchAccount(user, key, { voices: { ...now.voices, [p.id]: words } });
  }
}
