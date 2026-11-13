import type { Context } from "hono";
import { MEMORY_QUOTE_MIN, tidy } from "../../contracts/memory";
import { foundIn, saidInChat } from "../assistant";
import { jobTurn, type AuthVars } from "../auth";

/**
 * A style's own text (an editing style's notes, an animation style's brief) goes into the prompt of every later edit
 * in that style, so no AI writes it. A save that comes from a reply the assistant is writing (it carries that reply's
 * job token) keeps such a text only when it stands in something the person typed in that chat: the check a remembered
 * fact is held to (saidInChat, foundIn, and its shortest quote, so a text is never put together a word at a time), and
 * what is kept is their wording. A scheduled run has nobody typing, so it saves none. A save from the person's own
 * page, or from their own AI with an access key, is theirs and is not checked. True when the save is refused.
 */
export function notTyped(c: Context<{ Variables: AuthVars }>, b: Record<string, unknown>, keys: string[]): boolean {
  const auth = c.req.header("authorization");
  if (!/^Bearer ctj_/.test(auth ?? "")) return false;
  const said = saidInChat(c.get("user").username, jobTurn(auth) ?? "") ?? [];
  for (const k of keys) {
    const sent = b[k];
    if (typeof sent !== "string" || !sent.trim()) continue;
    const typed = tidy(sent).length < MEMORY_QUOTE_MIN ? null : said.map((m) => foundIn(sent, m.text)).find((t) => !!t);
    if (!typed) return true;
    b[k] = typed;
  }
  return false;
}
