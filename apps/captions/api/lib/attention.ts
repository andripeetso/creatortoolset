/**
 * "This person's attention is needed" in the assistant's chat (api/assistant.ts): a reply ended (done or failed), or it
 * asks something of them (an Allow / Deny, a Yes / No card, a key's secure box). The app sends nothing itself; an
 * install's plug-in listens and tells the person its own way (a phone push). A listener that throws is passed over.
 */

export interface Attention {
  username: string;
  /** The reply it is about (the same reply can ask and later end: a listener that wants one notice per reply counts these). */
  reply: string;
  kind: "done" | "failed" | "asks";
  /** One line each: the chat's title, then what happened. */
  title: string;
  body: string;
  /** The app path that opens that chat: /?chat=<id> (any page opens the assistant on it). */
  path: string;
  /** When the person sent the message the reply is for (ms). */
  sentAt: number;
}

type Listener = (a: Attention) => void | Promise<void>;
const listeners = new Set<Listener>();

/** Listen; returns the unsubscribe. */
export function onAttention(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function needsAttention(a: Attention): void {
  for (const fn of listeners) {
    try {
      void Promise.resolve(fn(a)).catch(() => {});
    } catch {
      /* one listener's failure is not the chat's */
    }
  }
}
