import { EventEmitter } from "node:events";
import type { MiddlewareHandler } from "hono";
import type { SessionStatus } from "./workshop/types";

// The core's event bus. Each name is emitted by the route that made the change, after the write it describes.
// A listener that throws (or returns a rejected promise) is logged and skipped, so a plug-in listener can never
// fail the request that emitted the event.

export interface CoreEvents {
  "export.finished": { id: string; owner?: string; kind: string; format: string; bytes: number };
  "review.version.added": { asset: string; n: number; owner: string };
  "session.published": { id: string; owner: string; from: SessionStatus };
  "session.status": { id: string; owner: string; from: SessionStatus; to: SessionStatus };
  /** Something in a Media Library changed (a piece, an item, a collection, a file): open Finals and Library pages refetch. */
  "library.changed": Record<string, never>;
}

export type EventName = keyof CoreEvents;

const bus = new EventEmitter();
bus.setMaxListeners(50);

const failed = (name: EventName, e: unknown) =>
  console.warn(`[events] ${name} listener failed: ${e instanceof Error ? e.message : String(e)}`);

/** Subscribe to one event. Returns the function that stops the subscription. */
export function onEvent<K extends EventName>(name: K, listener: (payload: CoreEvents[K]) => unknown): () => void {
  const safe = (payload: CoreEvents[K]) => {
    try {
      const result = listener(payload);
      if (result instanceof Promise) result.catch((e: unknown) => failed(name, e));
    } catch (e) {
      failed(name, e);
    }
  };
  bus.on(name, safe);
  return () => bus.off(name, safe);
}

/** Tell the listeners of one event what happened. Never throws. */
export function emitEvent<K extends EventName>(name: K, payload: CoreEvents[K]): void {
  bus.emit(name, payload);
}

/** Mount on a library router: every successful write (not a read) tells the library listeners once. */
export const notifyLibraryChanges: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.res.status < 300) emitEvent("library.changed", {});
};
