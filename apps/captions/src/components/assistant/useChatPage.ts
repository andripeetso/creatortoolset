import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

/** What moves the page beside the chats, given where things stood (`was`) and stand now. Null: the page stays. */
export function chatPageMove(
  was: { chat: string; card?: string } | null,
  now: { chat: string; card?: { id: string; href: string } },
  remembered: string | undefined,
): string | null {
  // chat mode just came on, or the app was loaded in it: the page on screen is the one asked for
  if (!was) return null;
  // the same chat: only something new it started moves the page
  if (was.chat === now.chat) return now.card && now.card.id !== was.card ? now.card.href : null;
  // another chat: back to where its page was left, else to the newest thing it made
  return remembered ?? now.card?.href ?? null;
}

/**
 * In chat mode the page beside the chats belongs to the open chat. Opening another chat puts this one's page aside
 * (remembered for as long as the window is open) and brings that chat's back: where you left it, else the newest thing
 * it made (a Workshop piece, an edit, a Review video). While a chat is open, something new it starts opens beside it.
 * In between the page is yours to move around in, and a chat that has made nothing leaves it where it is. Turning chat
 * mode on never moves the page, nor does a reload.
 */
export function useChatPage(active: boolean, chat: string | undefined, card: { id: string; href: string } | undefined): void {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const here = useRef("");
  here.current = pathname + search;
  const pages = useRef(new Map<string, string>());
  const was = useRef<{ chat: string; card?: string } | null>(null);
  useEffect(() => {
    if (!active) {
      // the page is hidden or chat mode is off: this chat's page is kept for when it shows again
      if (was.current) pages.current.set(was.current.chat, here.current);
      was.current = null;
      return;
    }
    if (!chat) return;
    const before = was.current;
    was.current = { chat, card: card?.id };
    if (before && before.chat !== chat) pages.current.set(before.chat, here.current);
    const to = chatPageMove(before, { chat, card }, pages.current.get(chat));
    if (to && to !== here.current) navigate(to);
    // the page moves when the chat or its newest card changes, never because the route did
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chat, card?.id]);
}
