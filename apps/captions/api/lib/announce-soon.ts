import { announce } from "./sync";

/**
 * announce() for a background job's saves: the first save of a burst is told at once, the rest at most once a
 * second, and the last one always (a job's final "done" save is never swallowed). Call it after the save resolved:
 * a tab that refetched before the save landed would keep the old copy with the new seq.
 */
const open = new Map<string, { again: boolean }>();

export function announceSoon(owner: string | null | undefined, topic: string, ms = 1000, chat?: string): void {
  if (!owner) return;
  // one burst per chat: two assistant chats streaming at once never swallow each other's notices
  const k = `${owner}\n${topic}\n${chat ?? ""}`;
  const held = open.get(k);
  if (held) {
    held.again = true;
    return;
  }
  announce(owner, topic, null, chat);
  const state = { again: false };
  open.set(k, state);
  const tick = () => {
    if (!state.again) return void open.delete(k);
    state.again = false;
    announce(owner, topic, null, chat);
    setTimeout(tick, ms).unref?.();
  };
  setTimeout(tick, ms).unref?.();
}
