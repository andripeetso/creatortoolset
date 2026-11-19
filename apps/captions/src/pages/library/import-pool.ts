/**
 * How many files of a drop do each stage at once (11-19: the Library sent them one after another, so 58 files waited on
 * each other's copy, index and upload). Every file starts at once and waits only at the stage that is full:
 * - copying into Source media: 3 at once per volume (a network volume is one volume: its share is the bottleneck);
 * - indexing (the page decodes the video for its length and pictures, then hands it in): the computer's cores, at most 4;
 * - calls to the server (the duplicate check): 4.
 * A file that fails or is slow holds only its own place. The server's analysis has its own pool (api/library/worker.ts).
 */

/** Runs `job` once fewer than `size` run; the rest wait their turn in order. */
export function gate(size: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (running >= size) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** One gate per key, each `size` wide (copies per volume). */
export function gates(size: number) {
  const by = new Map<string, ReturnType<typeof gate>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    let g = by.get(key);
    if (!g) by.set(key, (g = gate(size)));
    return g(job);
  };
}

/** The volume a path is on: "/Volumes/<name>" for an external or network disk, else the computer's own disk ("/"). */
export const volumeOf = (path: string): string => /^\/Volumes\/[^/]+/.exec(path)?.[0] ?? "/";

export const COPIES_PER_VOLUME = 3;
export const SERVER_CALLS = 4;
/** The computer's cores, at most 4; a window that doesn't say (0) gets 4. */
export const indexAtOnce = (cores = typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency) => Math.max(1, Math.min(4, cores || 4));

/** The three stage gates of one page: a drop's files share them, and so does the next drop while the first is going in. */
export function importGates() {
  return { copy: gates(COPIES_PER_VOLUME), index: gate(indexAtOnce()), server: gate(SERVER_CALLS) };
}
