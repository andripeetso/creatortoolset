import { Hono } from "hono";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./lib/env";
import type { AuthVars } from "./auth";
import { CHECK, DEFAULT_WORK_PREFS, EDITORS, JOBS, MAKES, TALK, type WorkPrefs } from "../contracts/work-prefs";

/** One record per account: $DATA_DIR/work-prefs/<user>.json (contracts/work-prefs.ts). */
const fileOf = (username: string) => path.join(env.dataDir, "work-prefs", `${username}.json`);

export function readWorkPrefs(username: string): WorkPrefs {
  try {
    return { ...DEFAULT_WORK_PREFS, ...(JSON.parse(readFileSync(fileOf(username), "utf-8")) as Partial<WorkPrefs>) };
  } catch {
    return { ...DEFAULT_WORK_PREFS };
  }
}

/** Apply a change; an unknown value is an error, a missing one keeps what was there. */
export function writeWorkPrefs(username: string, b: Record<string, unknown>): WorkPrefs | string {
  const next = readWorkPrefs(username);
  if (b.talk !== undefined) {
    if (!TALK.includes(b.talk as WorkPrefs["talk"])) return `talk is one of ${TALK.join(", ")}`;
    next.talk = b.talk as WorkPrefs["talk"];
  }
  if (b.check !== undefined) {
    if (!CHECK.includes(b.check as WorkPrefs["check"])) return `check is one of ${CHECK.join(", ")}`;
    next.check = b.check as WorkPrefs["check"];
  }
  if (b.editor !== undefined) {
    if (b.editor !== null && !EDITORS.includes(b.editor as never)) return `editor is one of ${EDITORS.join(", ")} (or null)`;
    next.editor = b.editor as WorkPrefs["editor"];
  }
  if (b.makes !== undefined) {
    if (!Array.isArray(b.makes) || !b.makes.every((m) => MAKES.includes(m as never))) return `makes is a list of ${MAKES.join(", ")}`;
    next.makes = [...new Set(b.makes as WorkPrefs["makes"])];
  }
  if (b.job !== undefined) {
    if (b.job !== null && !JOBS.includes(b.job as never)) return `job is one of ${JOBS.join(", ")} (or null)`;
    next.job = b.job as WorkPrefs["job"];
  }
  if (b.askFit !== undefined) {
    if (typeof b.askFit !== "boolean") return "askFit is true or false";
    next.askFit = b.askFit;
  }
  const file = fileOf(username);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(next));
  renameSync(`${file}.tmp`, file);
  return next;
}

export const workPrefsApp = new Hono<{ Variables: AuthVars }>();

workPrefsApp.get("/", (c) => c.json(readWorkPrefs(c.get("user").username)));

workPrefsApp.put("/", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const out = writeWorkPrefs(c.get("user").username, b);
  return typeof out === "string" ? c.json({ error: out }, 400) : c.json(out);
});
