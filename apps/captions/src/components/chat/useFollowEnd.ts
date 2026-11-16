import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps a chat's list at its newest message, the same in both chats. When a chat is put on screen (`shown` changes:
 * another chat, chat mode, the box opened) it is at the end at once, before the screen is drawn: never seen scrolling
 * down to it (owner, 11-14). What comes in while it shows (`deps`) scrolls into view, unless the reader has scrolled up
 * to re-read: then it stays put until they come back to the end or send. `shown` null = not on screen.
 * Returns `follow`: call it on send, so the reply is followed again. `away` is true while the reader is more than a
 * screen-ish up from the end (the Scroll to end pill shows then); `toEnd` takes them back down.
 */
export function useFollowEnd(list: () => HTMLElement | null | undefined, shown: string | null, deps: unknown[]): { follow: () => void; away: boolean; toEnd: () => void } {
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
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
      setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
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

  const follow = () => {
    atEnd.current = true;
  };
  const toEnd = () => {
    follow();
    const el = list();
    if (el) void el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  return { follow, away: shown !== null && away, toEnd };
}
