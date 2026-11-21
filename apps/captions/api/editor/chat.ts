import { Hono, type Context } from "hono";
import type { EditorChatView } from "../../contracts/editor";
import { editChat, forgetEditChat, newEditChat, sendEditTurn } from "../assistant";
import type { AuthVars } from "../auth";
import { editRole, readEdit } from "./store";

/**
 * The AI Editor's chat (contracts EditorChatView): an edit's chat is one of the person's chats with the assistant, so the
 * same conversation shows in the app's chats, beside the draft page and in the phone's edit thread, and is answered by
 * the person's own AI with the editor's tools. No edit ("") is the AI Editor's chat about no one edit.
 */
export const editorChatApp = new Hono<{ Variables: AuthVars }>();
type C = Context<{ Variables: AuthVars }>;

/** The edit asked about, when the caller may open it ("" = none asked); null: not found or not theirs. */
async function editOf(c: C, raw: unknown): Promise<{ id: string; name: string; projectId?: string } | "" | null> {
  const id = typeof raw === "string" ? raw : "";
  if (!id) return "";
  const e = readEdit(id);
  return e && (await editRole(c.get("user").username, e)) ? e : null;
}

export function chatView(username: string, edit: string): EditorChatView {
  const chat = editChat(username, edit);
  if (!chat) return { messages: [], turn: null };
  const said = chat.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.status !== "thinking").slice(-200);
  const now = [...chat.messages].reverse().find((m) => m.role === "assistant" && m.status === "thinking");
  return {
    chat: chat.id,
    messages: said.map((m) => ({
      id: m.id, role: m.role as "user" | "assistant", text: m.text, at: m.at,
      ...(m.steps?.length ? { steps: m.steps } : {}),
      ...(m.status === "error" ? { error: true } : {}),
      ...(edit ? { edit } : {}),
    })),
    turn: now ? { at: now.at, claimed: !!now.started, steps: now.steps ?? [] } : null,
  };
}

const NOT_FOUND = { error: "Edit not found", code: "not_found" } as const;

editorChatApp.get("/", async (c) => {
  const e = await editOf(c, c.req.query("edit"));
  return e === null ? c.json(NOT_FOUND, 404) : c.json(chatView(c.get("user").username, e ? e.id : ""));
});

/** { text, edit? }: a message to the edit's chat (made on the first one, in the edit's workspace), as the assistant's turn. */
editorChatApp.post("/", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { edit?: unknown } | null;
  const e = await editOf(c, b?.edit);
  if (e === null) return c.json(NOT_FOUND, 404);
  const user = c.get("user").username;
  const key = e ? e.id : "";
  const id = editChat(user, key)?.id ?? newEditChat(user, key, e ? e.name : "AI Editor", e ? e.projectId : undefined);
  const about = e
    ? `This chat is about the AI Editor edit ${JSON.stringify(e.name)} (edit id ${e.id}): a message here means that edit unless it names another.`
    : "This chat is the AI Editor's: the person is asking about their edits.";
  const res = await sendEditTurn(c, id, about);
  return res.ok ? c.json(chatView(user, key), 202) : res;
});

/** A new conversation about the edit: the old chat stays among the person's chats. */
editorChatApp.delete("/", async (c) => {
  const e = await editOf(c, c.req.query("edit"));
  if (e === null) return c.json(NOT_FOUND, 404);
  const user = c.get("user").username;
  forgetEditChat(user, e ? e.id : "");
  return c.json(chatView(user, e ? e.id : ""));
});
