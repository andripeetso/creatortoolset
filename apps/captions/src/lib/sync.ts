/**
 * The live half of the saved copies (lib/local-cache.ts): one stream per browser from GET /api/sync/events (api/lib/sync.ts)
 * says which topic changed and at which seq. Lists on screen whose copy is older refetch once, 300 ms later (a burst
 * of saves is one refetch), and a hidden window waits until it is shown. Nothing here carries data.
 *
 * Order, as a snapshot-plus-events protocol: a list fetched at seq N skips any notice ≤ N. Fetches wait for the
 * stream's hello (or 1.5 s), so a change between the fetch and the stream is never lost. On reconnect the hello's
 * per-topic seqs catch what was missed; a new boot id (the server restarted) makes every list on screen refetch.
 *
 * This tab's own writes carry its id (X-CT-Client) and their notices are skipped here unless a list asks for them
 * (`own`): the page already shows what it saved, and a refetch could undo typing. Other tabs and devices refetch.
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
const subs = new Map<string, Set<Sub>>();
let hello: Promise<void> = Promise.resolve();

export const seqNow = () => seq;
export const boot = () => bootId;
/** Resolves once the stream has said hello (or after 1.5 s without it: the saved copies still show). */
export const syncReady = () => hello;

type Sub = { fn: (latest: number) => void; own: boolean };
/**
 * Calls `fn(latestSeq)` whenever `topic` changes. `own`: also for this tab's own writes (skipped by default).
 * Returns the unsubscribe.
 */
export function onTopic(topic: string, fn: (latest: number) => void, opts?: { own?: boolean }): () => void {
  let set = subs.get(topic);
  if (!set) subs.set(topic, (set = new Set()));
  const sub = { fn, own: !!opts?.own };
  set.add(sub);
  return () => void set.delete(sub);
}

function tell(topic: string, ownWrite = false) {
  const n = latest.get(topic) ?? 0;
  for (const s of subs.get(topic) ?? []) if (!ownWrite || s.own) s.fn(n);
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

type Hello = { boot: string; seq: number; topics: Record<string, number> };
type Change = { seq: number; topic: string; origin: string | null };
let firstHello: (() => void) | null = null;

function onHello(h: Hello) {
  // a restart resets every seq: what this tab knew no longer compares (saved copies carry the old boot id)
  const restarted = h.boot !== bootId;
  if (restarted) latest.clear();
  bootId = h.boot;
  seq = restarted ? h.seq : Math.max(seq, h.seq);
  for (const [t, n] of Object.entries(h.topics)) latest.set(t, Math.max(latest.get(t) ?? 0, n));
  firstHello?.();
  firstHello = null;
  // a (re)connect: every topic on screen checks itself against the hello
  for (const t of subs.keys()) tell(t);
}
function onChange(n: Change) {
  seq = Math.max(seq, n.seq);
  latest.set(n.topic, n.seq);
  tell(n.topic, n.origin === clientId);
}
const helloNow = (): Hello => ({ boot: bootId, seq, topics: Object.fromEntries(latest) });

// ---- one stream for all of this browser's tabs: a local server over plain HTTP allows six connections per host, so
// one tab (the holder of a Web Lock) opens it and passes each event to the others over a BroadcastChannel. When that
// tab closes, the next one takes the lock and opens it. Without those APIs each tab opens its own.
let channel: BroadcastChannel | null = null;
let stopLeading: (() => void) | null = null;

function openStream(): () => void {
  const source = new EventSource("/api/sync/events", { withCredentials: true });
  source.addEventListener("hello", (e) => {
    const h = JSON.parse((e as MessageEvent).data) as Hello;
    onHello(h);
    channel?.postMessage({ hello: h });
  });
  source.addEventListener("change", (e) => {
    const n = JSON.parse((e as MessageEvent).data) as Change;
    onChange(n);
    channel?.postMessage({ change: n });
  });
  // EventSource reconnects by itself; the next hello catches up
  return () => source.close();
}

/** Opens the stream for the signed-in account (main.tsx, after sign-in). Safe to call again: one per tab at most. */
export function startSync() {
  if (stopLeading || channel || typeof EventSource === "undefined") return;
  hello = new Promise<void>((resolve) => {
    firstHello = resolve;
    setTimeout(resolve, 1500);
  });
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof BroadcastChannel === "undefined") {
    stopLeading = openStream();
    return;
  }
  channel = new BroadcastChannel("ct-sync");
  let leading = false;
  channel.onmessage = (e: MessageEvent<{ hello?: Hello; change?: Change; ask?: true }>) => {
    if (e.data.ask && leading && bootId) channel?.postMessage({ hello: helloNow() });
    else if (e.data.hello) onHello(e.data.hello);
    else if (e.data.change) onChange(e.data.change);
  };
  const ac = new AbortController();
  void locks
    .request("ct-sync-stream", { signal: ac.signal }, () => {
      leading = true;
      const close = openStream();
      return new Promise<void>((release) => {
        stopLeading = () => {
          close();
          release();
        };
      });
    })
    .catch(() => {});
  stopLeading ??= () => ac.abort();
  // a tab that is not the one streaming asks for the current hello
  channel.postMessage({ ask: true });
}

/** Sign-out: the stream closes, and nothing it knew carries over to the next account. */
export function stopSync() {
  stopLeading?.();
  stopLeading = null;
  channel?.close();
  channel = null;
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
