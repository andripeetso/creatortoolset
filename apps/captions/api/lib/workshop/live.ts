/**
 * A reply's words as they arrive, pushed to the page. The chat file
 * is written at most every 400 ms and the page used to ask once a second; this hands every piece of text from the
 * Mac to whoever has the session open, in memory. One process, so a Map is enough.
 */
type Event = { text: string } | { end: true };
type Listener = (e: Event) => void;

const listeners = new Map<string, Set<Listener>>();
const latest = new Map<string, string>();

/** The reply's text so far (the whole of it, not a delta: a page that joins late still gets everything). */
export function liveText(messageId: string, text: string): void {
  if (latest.get(messageId) === text) return;
  latest.set(messageId, text);
  listeners.get(messageId)?.forEach((f) => f({ text }));
}

/** The turn is over: listeners close; the page reads the finished message from the chat. */
export function liveEnd(messageId: string): void {
  latest.delete(messageId);
  listeners.get(messageId)?.forEach((f) => f({ end: true }));
  listeners.delete(messageId);
}

/** Listen; what has arrived so far comes at once. Returns the unsubscribe. */
export function listen(messageId: string, f: Listener): () => void {
  let set = listeners.get(messageId);
  if (!set) listeners.set(messageId, (set = new Set()));
  set.add(f);
  const now = latest.get(messageId);
  if (now) f({ text: now });
  return () => {
    set!.delete(f);
    if (!set!.size) listeners.delete(messageId);
  };
}
