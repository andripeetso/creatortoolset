import type { Context } from "hono";
import type { ActionNeeded } from "../../contracts/library";
import type { AuthVars } from "../auth";

/**
 * A chat card's goal is reached, by its own button or any other route (Settings → Folders, the Library's setup, another
 * device): the cards it answers are taken off their messages, and the change goes out on the change stream (D14: a
 * client reads `message.action` only and never acts on a 2xx body). With `goOn`, a card that was its chat's last word
 * carries the ask it stopped on (`say` makes the next message from it). assistant.ts says how (onActionDone); with no
 * assistant loaded nothing is shown, so nothing is done.
 */
export type GoOn = { say: (ask: string) => string; url: string; admin: boolean };
type Handler = (username: string, done: (a: ActionNeeded) => boolean, goOn?: GoOn) => void;
let handler: Handler | null = null;
export const onActionDone = (fn: Handler) => void (handler = fn);
export const actionDone: Handler = (username, done, goOn) => handler?.(username, done, goOn);

/** This server's address as the request saw it (PUBLIC_ORIGIN first): a turn's MCP address is `${it}/api/mcp`. */
export const publicOrigin = (c: Context) => {
  const url = new URL(c.req.url);
  return process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${url.host}`;
};
/** How a request that reached a card's goal carries the chat on: its own server address and the asker's role. */
export const goOnFor = (c: Context<{ Variables: AuthVars }>, say: GoOn["say"]): GoOn => ({ say, url: `${publicOrigin(c)}/api/mcp`, admin: c.get("user").role === "admin" });
