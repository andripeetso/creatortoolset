import { InstagramError } from "./base";

/**
 * Apify bills every actor run its start-up cost (booting the scraper takes
 * longer than scraping one post), so single-URL runs are the expensive way
 * to fetch posts. The batcher holds requests for a short window and sends
 * them as one run per results type; URLs the first type did not return are
 * retried once with the other type, again as one run.
 */

export type ResultsType = "posts" | "reels";

export interface BatchRunner<T> {
  (urls: string[], resultsType: ResultsType): Promise<Map<string, T>>;
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

interface Pending<T> {
  reelHint: boolean;
  waiters: Waiter<T>[];
}

export interface BatchOptions {
  /** How long to hold the first request while more arrive. */
  waitMs: number;
  /** Flush early once this many URLs are waiting. */
  maxSize: number;
}

export class PostBatcher<T> {
  private pending = new Map<string, Pending<T>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Runs started so far (for tests and logs). */
  runs = 0;

  constructor(
    private readonly run: BatchRunner<T>,
    private readonly opts: BatchOptions,
  ) {}

  request(url: string, reelHint: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cur = this.pending.get(url);
      if (cur) {
        cur.waiters.push({ resolve, reject });
        return;
      }
      this.pending.set(url, { reelHint, waiters: [{ resolve, reject }] });
      if (this.pending.size >= this.opts.maxSize) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.opts.waitMs);
        if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
      }
    });
  }

  get size(): number {
    return this.pending.size;
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = new Map();
    if (!batch.size) return;
    const settle = (url: string, result: T | undefined, error?: unknown) => {
      const p = batch.get(url);
      if (!p) return;
      batch.delete(url);
      for (const w of p.waiters) {
        if (result !== undefined) w.resolve(result);
        else w.reject(error ?? new InstagramError("Apify returned no post for this link", "NOT_FOUND", false));
      }
    };
    const groups: Record<ResultsType, string[]> = { posts: [], reels: [] };
    for (const [url, p] of batch) groups[p.reelHint ? "reels" : "posts"].push(url);
    const pass = async (type: ResultsType, urls: string[]): Promise<string[]> => {
      if (!urls.length) return [];
      this.runs++;
      try {
        const found = await this.run(urls, type);
        const missing: string[] = [];
        for (const url of urls) {
          const hit = found.get(url);
          if (hit !== undefined) settle(url, hit);
          else missing.push(url);
        }
        return missing;
      } catch (e) {
        for (const url of urls) settle(url, undefined, e);
        return [];
      }
    };
    const [missingPosts, missingReels] = await Promise.all([
      pass("posts", groups.posts),
      pass("reels", groups.reels),
    ]);
    // Second chance with the other results type, still one run per type.
    await Promise.all([pass("reels", missingPosts), pass("posts", missingReels)]);
    for (const url of [...batch.keys()]) settle(url, undefined);
  }
}
