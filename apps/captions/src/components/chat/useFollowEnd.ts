import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Keeps a chat's list at its newest message, the same in both chats. When a chat is put on screen (`shown` changes:
 * another chat, chat mode, the box opened) it is at the end at once, before the screen is drawn: never seen scrolling
 * down to it (owner, 11-14). What comes in while it shows (`deps`) scrolls into view, unless the reader has scrolled up
 * to re-read: then it stays put until they come back to the end or send. `shown` null = not on screen.
 * Returns `follow`: call it on send, so the reply is followed again.
 */
export function useFollowEnd(list: () => HTMLElement | null | undefined, shown: string | null, deps: unknown[]): () => void {
  const atEnd = useRef(true);
  const shownAs = useRef<string | null>(null);

  // only a move up lets go: a smooth scroll on its way down, or the list growing under it, never does
  useEffect(() => {
    const el = list();
    if (!el) return;
    let top = el.scrollTop;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) atEnd.current = true;
      else if (el.scrollTop < top - 2) atEnd.current = false;
      top = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (shown === null) return void (shownAs.current = null);
    const el = list();
    if (!el) return;
    if (shownAs.current !== shown) {
      shownAs.current = shown;
      atEnd.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    // void: a browser with scroll promises returns one here, and an effect that returns anything but a function crashes
    if (atEnd.current) void el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return () => {
    atEnd.current = true;
  };
}
