import { Hono } from "hono";
import { jobTurn, type AuthVars } from "./auth";
import { saidInChat } from "./assistant";
import { aiFor, completeWithFallback } from "./ai-complete";
import { currentProject, factOf, keep, listMemory, perWorkspace, remove, setPerWorkspace, setProject, setRule } from "./lib/memory";
import { inProjectOf } from "./lib/project-of";
import { MEMORY_QUOTE_MIN, MEMORY_RULE_MAX, tidy } from "../contracts/memory";

/**
 * What the assistant keeps from one chat to the next (contracts/memory.ts; the store and its rules: lib/memory.ts).
 *
 *   GET    /api/memory        the account's kept facts, newest first (Settings → Memory): the ones for every workspace
 *                             and the request's workspace's; ?all=1 = every workspace's; ?here=1 = only the ones a
 *                             chat gets now: about the person, and the current project's. `perWorkspace`: the setting below
 *   PUT    /api/memory/workspaces  { perWorkspace } each workspace keeps its own new facts, or they are shared by all
 *   POST   /api/memory        { quote, rule?, project? } keep what the person said: only from a reply the assistant is writing
 *   PATCH  /api/memory/:id    { text } the rule in the person's own wording (Settings → Memory: Edit)
 *   PUT    /api/memory/:id/workspace  { workspace } the workspace a rule is for; null = every workspace (Settings → Memory: Move to …)
 *   POST   /api/memory/:id/rewrite  the rule written again by their AI, not saved: Edit shows it first
 *   DELETE /api/memory/:id    remove one for good
 *
 * There is one way in, and it is checked here, not by the AI: the call must carry the token of a reply that is being
 * written in a chat the person is in (the assistant's remember tool sends it), and the quote must stand in what the
 * person typed themselves in that chat. No page, script or AI key can add a fact, and no AI can add one of its own.
 */
export const memoryApp = new Hono<{ Variables: AuthVars }>();

memoryApp.get("/", async (c) => {
  const u = c.get("user");
  return c.json({ facts: await listMemory(u, c.req.query("here") === "1" ? "here" : c.req.query("all") === "1" ? "all" : undefined), perWorkspace: perWorkspace(u.username) });
});

memoryApp.post("/", async (c) => {
  const u = c.get("user");
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { quote?: unknown; rule?: unknown; project?: unknown };
  const turn = jobTurn(c.req.header("authorization"));
  const said = turn ? saidInChat(u.username, turn) : null;
  if (!said) return c.json({ error: "Only the assistant keeps things, from what the person says to it in a chat." }, 403);
  // "only for this project", or each workspace keeps its own: filed to the chat's workspace. With none to file it under,
  // it is about the person
  const project = b.project === true || perWorkspace(u.username) ? await currentProject(u) : undefined;
  const out = keep(u.username, b.quote, said, project?.id, b.rule);
  if ("error" in out) return c.json({ error: out.error }, 409);
  return c.json({ id: out.fact.id, text: out.fact.text, ...(out.fact.said ? { said: out.fact.said } : {}), at: out.fact.at, ...(project && out.fact.project ? { project: { id: project.id, name: project.name } } : {}) }, out.added ? 201 : 200);
});

/** Edit and Rewrite are the person's, from Settings: a reply's token (or any token) never changes a rule. */
const fromPage = (c: { req: { header: (n: string) => string | undefined } }) => !c.req.header("authorization");

memoryApp.patch("/:id", async (c) => {
  if (!fromPage(c)) return c.json({ error: "A rule is changed in Settings, Memory" }, 403);
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { text?: unknown };
  const out = setRule(c.get("user").username, c.req.param("id"), b.text);
  if (!out) return c.json({ error: "Not found" }, 404);
  if ("error" in out) return c.json(out, 400);
  return c.json({ id: out.id, text: out.text, said: out.said });
});

memoryApp.put("/workspaces", async (c) => {
  if (!fromPage(c)) return c.json({ error: "Memory is set in Settings, Memory" }, 403);
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { perWorkspace?: unknown };
  if (typeof b.perWorkspace !== "boolean") return c.json({ error: "Send { perWorkspace: true or false }" }, 400);
  setPerWorkspace(c.get("user").username, b.perWorkspace);
  return c.json({ perWorkspace: b.perWorkspace });
});

memoryApp.put("/:id/workspace", async (c) => {
  if (!fromPage(c)) return c.json({ error: "A rule is changed in Settings, Memory" }, 403);
  const u = c.get("user");
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { workspace?: unknown };
  const to = typeof b.workspace === "string" && b.workspace ? b.workspace : null;
  if (b.workspace !== null && !(to && (await inProjectOf(u, to)))) return c.json({ error: "Workspace not found" }, 400);
  const out = setProject(u.username, c.req.param("id"), to ?? undefined);
  return out ? c.json({ id: out.id, ...(out.project ? { workspace: out.project } : {}) }) : c.json({ error: "Not found" }, 404);
});

const REWRITE = `You turn one thing a person told their AI assistant to remember into a standing instruction for that assistant.
Keep the meaning exactly, and every specific they named (words, examples, times, names). Drop filler, swearing, typos and talk to the AI ("remember", "I hate that").
Write one plain sentence in the imperative, at most ${MEMORY_RULE_MAX} characters. Answer with that sentence alone.`;

memoryApp.post("/:id/rewrite", async (c) => {
  if (!fromPage(c)) return c.json({ error: "A rule is changed in Settings, Memory" }, 403);
  const u = c.get("user");
  const f = factOf(u.username, c.req.param("id"));
  if (!f) return c.json({ error: "Not found" }, 404);
  const ai = aiFor(u, "workshop", "Memory");
  if (ai.off) return c.json({ error: ai.off }, 503);
  const prompt = f.said ? `What they said: ${f.said}\nThe instruction so far: ${f.text}` : `What they said: ${f.text}`;
  try {
    const text = await completeWithFallback(REWRITE, prompt, undefined, (t) => {
      const one = tidy(t).replace(/^["'](.*)["']$/, "$1");
      if (one.length < MEMORY_QUOTE_MIN || one.length > MEMORY_RULE_MAX) throw new Error("The rewrite was too long or empty");
      return one;
    }, ai);
    return c.json({ text });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Could not rewrite the rule" }, 502);
  }
});

memoryApp.delete("/:id", (c) => (remove(c.get("user").username, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));
