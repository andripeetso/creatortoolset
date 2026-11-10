/**
 * The live half of the saved copies (lib/local-cache.ts): one stream per tab from GET /api/sync/events (api/lib/sync.ts)
 * says which topic changed and at which seq. Lists on screen whose copy is older refetch once, 300 ms later (a burst
 * of saves is one refetch), and a hidden window waits until it is shown. Nothing here carries data.
 *
 * Order, as a snapshot-plus-events protocol: a list fetched at seq N skips any notice ≤ N. Fetches wait for the
 * stream's hello (or 1.5 s), so a change between the fetch and the stream is never lost. On reconnect the hello's
 * per-topic seqs catch what was missed; a new boot id (the server restarted) makes every list on screen refetch.
 *
 * This tab's own writes carry its id (X-CT-Client) and their notices are skipped here: the page already shows what it
 * saved, and a refetch could undo typing. Other tabs and devices refetch.
 */

/** The topic of a saved list's key or an /api address: "/api/review/x" → "review", "workshop/sessions?p=" → "workshop". */
export function topicOf(key: string): string | null {
  const m = /^(?:\/api\/)?(x\/[^/?#|]+|[^/?#|]+)/.exec(key);
  return m ? m[1] : null;
}

export const clientId = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Math.random().toString(36).slice(2)}`;
  }
})();

let seq = 0;
let bootId = "";
const latest = new Map<string, number>();
const subs = new Map<string, Set<(latest: number) => void>>();
let hello: Promise<void> = Promise.resolve();
let es: EventSource | null = null;

export const seqNow = () => seq;
export const boot = () => bootId;
/** Resolves once the stream has said hello (or after 1.5 s without it: the saved copies still show). */
export const syncReady = () => hello;

/** Calls `fn(latestSeq)` whenever `topic` changes. Returns the unsubscribe. */
export function onTopic(topic: string, fn: (latest: number) => void): () => void {
  let set = subs.get(topic);
  if (!set) subs.set(topic, (set = new Set()));
  set.add(fn);
  return () => void set.delete(fn);
}

function tell(topic: string) {
  const n = latest.get(topic) ?? 0;
  for (const fn of subs.get(topic) ?? []) fn(n);
}

// ---- refetch scheduling: coalesced per key, held while the window is hidden
const due = new Map<string, () => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
function run() {
  timer = null;
  if (typeof document !== "undefined" && document.hidden) return; // visibilitychange runs them
  const jobs = [...due.values()];
  due.clear();
  for (const job of jobs) job();
}
/** Runs `fn` for `key` about 300 ms from now (once, however many times it is asked), or when the window is shown. */
export function whenVisible(key: string, fn: () => void) {
  due.set(key, fn);
  timer ??= setTimeout(run, 300);
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => !document.hidden && run());

/** Opens the stream for the signed-in account (main.tsx, after sign-in). Safe to call again: one stream per tab. */
export function startSync() {
  if (es || typeof EventSource === "undefined") return;
  let first: (() => void) | null = null;
  hello = new Promise<void>((resolve) => {
    first = resolve;
    setTimeout(resolve, 1500);
  });
  es = new EventSource("/api/sync/events", { withCredentials: true });
  es.addEventListener("hello", (e) => {
    const h = JSON.parse((e as MessageEvent).data) as { boot: string; seq: number; topics: Record<string, number> };
    // a restart resets every seq: what this tab knew no longer compares (saved copies carry the old boot id)
    if (h.boot !== bootId) latest.clear();
    bootId = h.boot;
    seq = h.seq;
    for (const [t, n] of Object.entries(h.topics)) latest.set(t, n);
    first?.();
    first = null;
    // a (re)connect: every topic on screen checks itself against the hello
    for (const t of subs.keys()) tell(t);
  });
  es.addEventListener("change", (e) => {
    const n = JSON.parse((e as MessageEvent).data) as { seq: number; topic: string; origin: string | null };
    seq = Math.max(seq, n.seq);
    latest.set(n.topic, n.seq);
    if (n.origin !== clientId) tell(n.topic);
  });
  // EventSource reconnects by itself; the next hello catches up
}

/** Sign-out: the stream closes, and nothing it knew carries over to the next account. */
export function stopSync() {
  es?.close();
  es = null;
  seq = 0;
  bootId = "";
  latest.clear();
  hello = Promise.resolve();
}

/** Every same-origin write from this tab carries its id, so its own change notices are skipped here. */
export function tagWrites() {
  const orig = globalThis.fetch;
  if ((orig as { ctTagged?: boolean }).ctTagged) return;
  const tagged = (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const same = url.startsWith("/") || url.startsWith(location.origin);
    if (method !== "GET" && method !== "HEAD" && same) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("X-CT-Client", clientId);
      return orig(input, { ...init, headers });
    }
    return orig(input, init);
  };
  (tagged as { ctTagged?: boolean }).ctTagged = true;
  globalThis.fetch = tagged as typeof fetch;
}
