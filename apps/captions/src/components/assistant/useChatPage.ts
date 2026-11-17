import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { currentWorkspace } from "@/lib/current-workspace";
import { pageWorkspace } from "@/lib/page-workspace";

/** A chat's page as it was left: its address and the workspace it was opened in. */
export type ChatPage = { path: string; ws?: string | null };

/** What moves the page beside the chats, given where things stood (`was`) and stand now. Null: the page stays. */
export function chatPageMove(
  was: { chat: string; card?: string } | null,
  now: { chat: string; card?: { id: string; href: string }; ws?: string | null; bare?: boolean },
  remembered: ChatPage | undefined,
): string | null {
  // chat mode just came on, or the app was loaded in it: the page on screen is the one asked for
  if (!was) return null;
  // the same chat: only something new it started moves the page
  if (was.chat === now.chat) return now.card && now.card.id !== was.card ? now.card.href : null;
  // another chat that has no page (a new chat): none comes beside it
  if (now.bare) return null;
  // another chat: back to where its page was left while that is in its workspace, else to the newest thing it made,
  // else to its workspace's Home. Never the page of the chat before it: that is another chat's, maybe another workspace's
  return (remembered && remembered.ws === now.ws ? remembered.path : null) ?? now.card?.href ?? "/";
}

/**
 * In chat mode the page beside the chats belongs to the open chat. Opening another chat puts this one's page aside
 * (remembered for as long as the window is open) and brings that chat's back: where you left it, else the newest thing
 * it made (a Workshop piece, an edit, a Review video), else its workspace's Home. While a chat is open, something new
 * it starts opens beside it. In between the page is yours to move around in. Turning chat mode on never moves the page,
 * nor does a reload (a page of another workspace leaves by itself: lib/page-workspace.ts).
 *
 * `active`: the page follows the chat (chat mode, with the page wanted beside the chats). `shown`: the page is drawn
 * now; a new chat's is not until it has one, and a page that was not drawn is not remembered as that chat's. `ws`: the
 * open chat's workspace (none: the window's). `onPage`: the open chat's page is the one already loaded, so no move will
 * bring it on show.
 */
export function useChatPage(active: boolean, shown: boolean, chat: string | undefined, ws: string | undefined, card: { id: string; href: string } | undefined, onPage: () => void): void {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const here = useRef("");
  here.current = pathname + search;
  const pages = useRef(new Map<string, ChatPage>());
  const was = useRef<{ chat: string; card?: string } | null>(null);
  const shownWas = useRef(shown);
  useEffect(() => {
    const keep = (id: string) => pages.current.set(id, { path: here.current, ws: pageWorkspace() });
    if (!active) {
      // the page is hidden or chat mode is off: this chat's page is kept for when it shows again
      if (was.current && shownWas.current) keep(was.current.chat);
      was.current = null;
      return;
    }
    if (!chat) return;
    const before = was.current;
    was.current = { chat, card: card?.id };
    if (before && before.chat !== chat && shownWas.current) keep(before.chat);
    const to = chatPageMove(before, { chat, card, ws: ws ?? currentWorkspace(), bare: !shown }, pages.current.get(chat));
    if (!to) return;
    // a move shows the page by itself (the dock follows the route)
    if (to !== here.current) navigate(to);
    else onPage();
    // the page moves when the chat or its newest card changes, never because the route did
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chat, card?.id]);
  // after the effect above, which goes by how things stood before this render
  useEffect(() => {
    shownWas.current = shown;
  });
}
