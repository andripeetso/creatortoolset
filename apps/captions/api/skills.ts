import { Hono } from "hono";
import { unattended } from "./assistant";
import { innerCall, jobTurn, type AuthVars } from "./auth";
import { listInstalled } from "./lib/packs";
import { SkillError, addSkill, dockSkills, listSkills, removeSkill, setSharedOn, sharedSkills, sharedSwitches, skillNamed, updateSkill } from "./lib/skills";

/**
 * Community → Skills (contracts/skills.ts, api/lib/skills.ts): the person's own skills and the ones their installed packs
 * and the server's plug-ins bring. The list, add one for a place, change (text, on or off, the projects it is for) and
 * remove; a shared skill's switch; and the one read the assistant's skill_read makes, which serves only their own.
 *
 * A write takes a place, a name, the line that says when to use it, and the body, and keeps nothing else: a dropped
 * file is read in the browser (parseSkillFile), and only those reach the server.
 */
export const skillsApp = new Hono<{ Variables: AuthVars }>();

/**
 * Skills are written by the person at their own screen and by nobody else: not by a tool's call (which runs as the
 * account, innerCall), and not by an AI key or a job token (an Authorization header). An AI never adds or changes one.
 */
skillsApp.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  if (c.get("user").role === "visitor" || innerCall.getStore() || c.req.header("authorization"))
    return c.json({ error: "Skills are added and changed by the person, in Community → Skills." }, 403);
  return next();
});

const refusal = (e: unknown) => {
  if (e instanceof SkillError) return e.message;
  throw e;
};

const sharedOf = async (username: string) => sharedSkills(await listInstalled(username), await sharedSwitches(username));

skillsApp.get("/", async (c) => {
  const username = c.get("user").username;
  return c.json({ skills: await listSkills(username), shared: await sharedOf(username) });
});

/** A shared skill's switch: `{on}`. */
skillsApp.patch("/shared/:id", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (typeof b.on !== "boolean") return c.json({ error: "on: true or false" }, 400);
  const username = c.get("user").username;
  try {
    const skill = await setSharedOn(username, c.req.param("id"), b.on, await sharedOf(username));
    return skill ? c.json(skill) : c.json({ error: "Not found" }, 404);
  } catch (e) {
    return c.json({ error: refusal(e) }, 400);
  }
});

/** One skill's text by its name, for the assistant: only one of the person's own assistant skills on in the project the app is in. */
skillsApp.get("/read", async (c) => {
  // a scheduled run is given no skill (its prompt lists none and skill_read is not in its tools): asked by name, it is refused
  const turn = jobTurn(c.req.header("authorization"));
  if (turn && unattended(c.get("user").username, turn)) return c.json({ error: "A scheduled run reads no skills: carry on without one." }, 409);
  const on = await dockSkills(c.get("user").username);
  const skill = skillNamed(on, c.req.query("name") ?? "");
  if (!skill) return c.json({ error: on.length ? `No skill of that name is on. On now: ${on.map((s) => s.name).join(", ")}.` : "The user has no skill switched on here." }, 409);
  return c.json({ name: skill.name, when: skill.when, text: skill.body });
});

skillsApp.post("/", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    return c.json(await addSkill(c.get("user").username, b), 201);
  } catch (e) {
    return c.json({ error: refusal(e) }, 400);
  }
});

skillsApp.patch("/:id", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    const skill = await updateSkill(c.get("user").username, c.req.param("id"), b);
    return skill ? c.json(skill) : c.json({ error: "Not found" }, 404);
  } catch (e) {
    return c.json({ error: refusal(e) }, 400);
  }
});

skillsApp.delete("/:id", async (c) => {
  try {
    return (await removeSkill(c.get("user").username, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  } catch (e) {
    return c.json({ error: refusal(e) }, 400);
  }
});
