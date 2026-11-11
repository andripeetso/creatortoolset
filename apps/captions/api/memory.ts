import { Hono } from "hono";
import { jobTurn, type AuthVars } from "./auth";
import { saidInChat } from "./assistant";
import { currentProject, keep, listMemory, remove } from "./lib/memory";

/**
 * What the assistant keeps from one chat to the next (contracts/memory.ts; the store and its rules: lib/memory.ts).
 *
 *   GET    /api/memory        the account's kept facts, newest first (Settings → Memory)
 *   POST   /api/memory        { quote, project? } keep what the person said: only from a reply the assistant is writing
 *   DELETE /api/memory/:id    remove one for good
 *
 * There is one way in, and it is checked here, not by the AI: the call must carry the token of a reply that is being
 * written in a chat the person is in (the assistant's remember tool sends it), and the quote must stand in what the
 * person typed themselves in that chat. No page, script or AI key can add a fact, and no AI can add one of its own.
 */
export const memoryApp = new Hono<{ Variables: AuthVars }>();

memoryApp.get("/", async (c) => c.json({ facts: await listMemory(c.get("user")) }));

memoryApp.post("/", async (c) => {
  const u = c.get("user");
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { quote?: unknown; project?: unknown };
  const turn = jobTurn(c.req.header("authorization"));
  const said = turn ? saidInChat(u.username, turn) : null;
  if (!said) return c.json({ error: "Only the assistant keeps things, from what the person says to it in a chat." }, 403);
  // "only for this project" with no project to file it under: it is about the person
  const project = b.project === true ? await currentProject(u) : undefined;
  const out = keep(u.username, b.quote, said, project?.id);
  if ("error" in out) return c.json({ error: out.error }, 409);
  return c.json({ id: out.fact.id, text: out.fact.text, at: out.fact.at, ...(project && out.fact.project ? { project: { id: project.id, name: project.name } } : {}) }, out.added ? 201 : 200);
});

memoryApp.delete("/:id", (c) => (remove(c.get("user").username, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));
