import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { getSessionUser, type AuthVars } from "./auth";
import { anyAiConfigured } from "./ai-complete";
import { env } from "./lib/env";
import { listDevices } from "./lib/devices";
import { readConnectors } from "./lib/connectors/store";
import { publicApifyStatus, readApify } from "./lib/instagram/apify";
import { routeFor } from "./lib/providers";
import { ownedProjects } from "./lib/workshop/workspace";
import { homeOf } from "./library/access";
import { libraryDb } from "./library/db";
import { keyFor } from "./my-keys";
import {
  apiKeysOf,
  findUser,
  newApiKey,
  USERNAME_RE,
  type SessionUser,
} from "./users";
import { MY_KEYS } from "../contracts/service-keys";
import {
  isTool,
  TOOLS,
  type Have,
  type SetupView,
  type Tool,
} from "../contracts/tools";
import { isPlan, planFromCli, type PlanId } from "../contracts/plans";

/**
 * First-run setup and Settings → Setup: the tools a person uses (their own list, apart from Admin → Access), the plan
 * their AI runs on, whether they finished setup, and what they have set up (contracts/tools.ts Have) for the
 * readiness rows. $DATA_DIR/setup/<username>.json; accounts only (a share-link visitor has no setup).
 *
 *   GET /api/setup  → SetupView
 *   PUT /api/setup  { tools?: Tool[], plan?: PlanId | null, done?: boolean } → SetupView
 *   GET  /api/setup/connect → { clis: [{ driver }], hasKey }   the AI CLIs on this Mac (the Mac app's report)
 *   POST /api/setup/connect { run: boolean } → { ok } | { command }  setup's connect step (signed-in browser only)
 */

interface Saved {
  tools?: Tool[];
  plan?: PlanId;
  done?: boolean;
}

const fileOf = (u: string) =>
  USERNAME_RE.test(u) ? path.join(env.dataDir, "setup", `${u}.json`) : null;

function read(u: string): Saved | null {
  const f = fileOf(u);
  try {
    return f ? (JSON.parse(readFileSync(f, "utf-8")) as Saved) : null;
  } catch {
    return null;
  }
}

function write(u: string, s: Saved): void {
  const f = fileOf(u);
  if (!f) throw new Error("No setup for this account");
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(s));
  renameSync(`${f}.tmp`, f);
}

/** What this account has set up, each the way the tool that needs it checks. */
export async function haveFor(user: SessionUser): Promise<Have[]> {
  const u = user.username;
  const have: Have[] = MY_KEYS.filter((k) => keyFor(user, k.env).key).map(
    (k) => k.env,
  );
  if (anyAiConfigured(user)) have.push("ai");
  if (routeFor(u, user.role === "admin", "workshop")) have.push("ownAi");
  if ((await ownedProjects(u)).length) have.push("project");
  if (
    readConnectors(u).accounts.some(
      (a) => a.platform === "instagram" && a.via === "login",
    )
  )
    have.push("instagram");
  if (publicApifyStatus(await readApify(u)).configured) have.push("apify");
  if (
    libraryDb()
      .prepare("SELECT 1 FROM libraries WHERE workspace_id = ? LIMIT 1")
      .get(homeOf(u))
  )
    have.push("library");
  const full = (() => {
    const rec = findUser(u);
    return rec ? apiKeysOf(rec).full : null;
  })();
  if (full?.usedAt && full.usedAt >= (full.at ?? 0)) have.push("mcp");
  return have;
}

/** The plan a CLI on one of this account's Macs reported (the Mac app's report), if any says one. */
const detectedPlan = (u: string): PlanId | null =>
  listDevices((d) => d.owner === u)
    .flatMap((d) => d.report?.drivers ?? [])
    .map((r) => planFromCli(r.plan))
    .find(Boolean) ?? null;

async function view(user: SessionUser): Promise<SetupView> {
  const s = read(user.username) ?? {};
  return {
    tools: s.tools ?? null,
    plan: s.plan ?? null,
    detected: detectedPlan(user.username),
    done: !!s.done,
    have: await haveFor(user),
  };
}

export const setupApp = new Hono<{ Variables: AuthVars }>();

setupApp.use("*", async (c, next) =>
  fileOf(c.get("user").username) && c.get("user").role !== "visitor"
    ? next()
    : c.json({ error: "Sign in with an account to set up" }, 403),
);

setupApp.get("/", async (c) => c.json(await view(c.get("user"))));

setupApp.put("/", async (c) => {
  const user = c.get("user");
  const b = (await c.req.json().catch(() => null)) as {
    tools?: unknown;
    plan?: unknown;
    done?: unknown;
  } | null;
  if (!b) return c.json({ error: "Send { tools, plan, done }" }, 400);
  const next = { ...(read(user.username) ?? {}) };
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || !b.tools.every(isTool))
      return c.json({ error: `tools: some of ${TOOLS.join(", ")}` }, 400);
    next.tools = TOOLS.filter((t) => (b.tools as Tool[]).includes(t));
  }
  if (b.plan !== undefined) {
    if (b.plan !== null && !isPlan(b.plan))
      return c.json({ error: "No such plan" }, 400);
    if (b.plan === null) delete next.plan;
    else next.plan = b.plan;
  }
  if (b.done !== undefined) next.done = b.done === true;
  write(user.username, next);
  return c.json(await view(user));
});

/** The name this server goes by in the AI CLIs' MCP lists. */
const MCP_NAME = "creator-toolset";

/**
 * `claude mcp add` for this server on this Mac, for every project of the person's (user scope), as an argument list
 * for execFile (never a shell). The address is always this Mac's own server, never a hosted one.
 */
export function claudeMcpAdd(port: number, key: string): string[] {
  return [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "user",
    MCP_NAME,
    `http://127.0.0.1:${port}/api/mcp`,
    "--header",
    `Authorization: Bearer ${key}`,
  ];
}

/** The same, typed into a terminal: each argument with a space in quotes. */
export const shellLine = (bin: string, args: string[]) =>
  [bin, ...args]
    .map((a) => (/[^\w@%+=:,./-]/.test(a) ? `"${a}"` : a))
    .join(" ");

/** `codex mcp add` for this server: Codex 0.40+ takes an address; the key goes into its config (codexWithKey). */
export const codexMcpAdd = (port: number): string[] => [
  "mcp",
  "add",
  MCP_NAME,
  "--url",
  `http://127.0.0.1:${port}/api/mcp`,
];

/**
 * Codex's config.toml with the key header on this server's entry. `codex mcp add` takes a key only from an
 * environment variable, so it goes in as `http_headers` (a key Codex reads on that table) right under the header.
 */
export function codexWithKey(toml: string, key: string): string {
  const head = `[mcp_servers.${MCP_NAME}]`;
  const lines = toml
    .split("\n")
    .filter((l) => !/^http_headers\s*=.*ctk_/.test(l)); // an earlier key of ours
  const at = lines.findIndex((l) => l.trim() === head);
  if (at < 0) throw new Error("Codex didn't save the server");
  lines.splice(at + 1, 0, `http_headers = { Authorization = "Bearer ${key}" }`);
  return lines.join("\n");
}

/**
 * The AI CLIs found on this Mac: the paths the Mac app reported (MacReport.swift finds them) that exist here.
 */
const clisHere = (u: string) => {
  const seen = new Map<"claude" | "codex", string>();
  for (const r of listDevices((d) => d.owner === u).flatMap(
    (d) => d.report?.drivers ?? [],
  )) {
    if (
      (r.driver === "claude" || r.driver === "codex") &&
      r.installed &&
      r.path &&
      !seen.has(r.driver) &&
      existsSync(r.path)
    )
      seen.set(r.driver, r.path);
  }
  return [...seen].map(([driver, p]) => ({ driver, path: p }));
};

setupApp.get("/connect", (c) => {
  const rec = findUser(c.get("user").username);
  return c.json({
    clis: clisHere(c.get("user").username).map((x) => ({ driver: x.driver })),
    hasKey: !!(rec && apiKeysOf(rec).full),
  });
});

/**
 * Makes a Full key for this account (the old one stops working) and adds this server, with that one key, to every
 * AI CLI on this Mac (one key per account: adding them one at a time would cut off the one before), or (`run: false`)
 * hands back Claude Code's command to paste instead. The key goes only into the CLIs' config or that command.
 * A signed-in browser only: never a key or an MCP call, so a key can't make itself another one.
 */
setupApp.post("/connect", async (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const rec = session && findUser(session.username);
  if (!rec) return c.json({ error: "Sign in with an account first" }, 401);
  const b = (await c.req.json().catch(() => null)) as { run?: unknown } | null;
  const clis = clisHere(rec.username);
  if (b?.run === true && !clis.length)
    return c.json({ error: "No Claude Code or Codex on this Mac" }, 404);
  const port = Number(process.env.PORT || 3000);
  const key = newApiKey(rec, "full");
  if (b?.run !== true)
    return c.json({ command: shellLine("claude", claudeMcpAdd(port, key)) });
  const run = promisify(execFile);
  const added: string[] = [];
  const failed: string[] = [];
  for (const cli of clis) {
    const name = cli.driver === "claude" ? "Claude Code" : "Codex";
    // each CLI is a node script: its own folder first on PATH, so `env node` finds the node it came with
    const opts = {
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${path.dirname(cli.path)}:${process.env.PATH ?? ""}`,
      },
    };
    try {
      if (cli.driver === "claude") {
        await run(
          cli.path,
          ["mcp", "remove", "--scope", "user", MCP_NAME],
          opts,
        ).catch(() => null); // a second click replaces it
        await run(cli.path, claudeMcpAdd(port, key), opts);
      } else {
        await run(cli.path, ["mcp", "remove", MCP_NAME], opts).catch(
          () => null,
        );
        await run(cli.path, codexMcpAdd(port), opts);
        const file = path.join(
          process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
          "config.toml",
        );
        writeFileSync(file, codexWithKey(readFileSync(file, "utf8"), key));
      }
      added.push(name);
    } catch (e) {
      const why =
        (e as { stderr?: string }).stderr ||
        (e instanceof Error ? e.message : String(e));
      // Codex before 0.40 has no --url: say what to do, not its usage text
      failed.push(
        cli.driver === "codex" && /--url|unexpected argument/.test(why)
          ? "Codex: update Codex, then try again"
          : `${name}: ${why.replaceAll(key, "…").trim().slice(0, 200)}`,
      );
    }
  }
  if (!added.length) return c.json({ error: failed.join("; ") }, 500);
  return c.json({ ok: true, added, failed });
});
