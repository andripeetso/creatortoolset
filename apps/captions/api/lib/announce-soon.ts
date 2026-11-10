import { announce } from "./sync";

/**
 * announce() for a background job's saves: the first save of a burst is told at once, the rest at most once a
 * second, and the last one always (a job's final "done" save is never swallowed). Call it after the save resolved:
 * a tab that refetched before the save landed would keep the old copy with the new seq.
 */
const open = new Map<string, { again: boolean }>();

export function announceSoon(owner: string | null | undefined, topic: string, ms = 1000): void {
  if (!owner) return;
  const k = `${owner}\n${topic}`;
  const held = open.get(k);
  if (held) {
    held.again = true;
    return;
  }
  announce(owner, topic);
  const state = { again: false };
  open.set(k, state);
  const tick = () => {
    if (!state.again) return void open.delete(k);
    state.again = false;
    announce(owner, topic);
    setTimeout(tick, ms).unref?.();
  };
  setTimeout(tick, ms).unref?.();
}
