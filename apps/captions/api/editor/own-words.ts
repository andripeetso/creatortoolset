import type { Context } from "hono";
import { MEMORY_QUOTE_MIN, tidy } from "../../contracts/memory";
import { foundIn, pastedInChat, saidInChat } from "../assistant";
import { jobTurn, type AuthVars } from "../auth";

/** The answer's header that says a style's text was taken from the person's pasted text (the tool tells the AI, which tells them). */
export const WORDS_FROM = "x-ct-words-from";

/**
 * A style's own text (an editing style's notes, an animation style's brief) goes into the prompt of every later edit
 * in that style, so no AI writes it. A save that comes from a reply the assistant is writing (it carries that reply's
 * job token) keeps such a text only when it stands, word for word, in something the person gave in that chat:
 *   - what they typed there: the check a remembered fact is held to (saidInChat, foundIn, and its shortest quote, so a
 *     text is never put together a word at a time);
 *   - or a long text they pasted into the box with the message this reply answers (pastedInChat). That is for these
 *     two texts of a style alone: a remembered fact is still checked against typed words only.
 * What is kept is their wording, so the assistant picks the passage and never writes one. Never a reply, a note, a
 * highlight, the page's context, a file, a fetched page or a tool's answer: none of those is in either source. A
 * scheduled run has nobody at it, so it saves none. A save from the person's own page, or from their own AI with an
 * access key, is theirs and is not checked. True when the save is refused; `from` is told which source each kept text
 * came from.
 */
export function notTyped(c: Context<{ Variables: AuthVars }>, b: Record<string, unknown>, keys: string[]): boolean {
  const auth = c.req.header("authorization");
  if (!/^Bearer ctj_/.test(auth ?? "")) return false;
  const user = c.get("user").username;
  const turn = jobTurn(auth) ?? "";
  const said = (saidInChat(user, turn) ?? []).map((m) => m.text);
  const pasted = pastedInChat(user, turn) ?? [];
  for (const k of keys) {
    const sent = b[k];
    if (typeof sent !== "string" || !sent.trim()) continue;
    const long = tidy(sent).length >= MEMORY_QUOTE_MIN;
    const typed = long ? said.map((t) => foundIn(sent, t)).find((t) => !!t) : null;
    const fromPaste = long && !typed ? pasted.map((t) => foundIn(sent, t)).find((t) => !!t) : null;
    if (!typed && !fromPaste) return true;
    b[k] = typed ?? fromPaste;
    if (fromPaste) c.header(WORDS_FROM, "pasted");
  }
  return false;
}
