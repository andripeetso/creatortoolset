import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { aiFor, anyAiConfigured } from "./ai-complete";
import { env, hostedMode } from "./lib/env";
import { isOnline, listDevices } from "./lib/devices";
import { connectState } from "./connect/state";
import { joinServer, saveJoin } from "./lib/server-join";
import { readConnectors } from "./lib/connectors/store";
import { publicApifyStatus, readApify } from "./lib/instagram/apify";
import { deviceTranscribes } from "./lib/device-transcribe";
import { connectedOwn } from "./lib/providers";
import { addMcp, connectCli, installCli, localAiView, planOf, signIn, updateCli, CLI_IDS, MAC_ONLY, OTHER_AIS, VENDOR_AIS } from "./lib/local-ai";
import { ownedProjects } from "./lib/workshop/workspace";
import { ensureLibrary, homeOf } from "./library/access";
import { libraryDb } from "./library/db";
import { keyFor } from "./my-keys";
import { pluginNeeds } from "./lib/plugin";
import {
  apiKeysOf,
  findUser,
  USERNAME_RE,
  type SessionUser,
} from "./users";
import { viaTunnel, type AuthVars } from "./auth";
import { MY_KEYS } from "../contracts/service-keys";
import type { CliId, LocalAiView } from "../contracts/local-ai";
import type { Driver } from "../contracts/providers";
import { isTool, TOOLS, type Have, type SetupView, type Tool, HOME_TILES, isHomeTile, type HomeTile } from "../contracts/tools";
import { isPlan, type PlanId } from "../contracts/plans";

/**
 * First-run setup and Settings → Setup: the tools a person uses (their own list, apart from Admin → Access), the plan
 * their AI runs on, whether they finished setup, and what they have set up (contracts/tools.ts Have) for the
 * readiness rows. $DATA_DIR/setup/<username>.json; accounts only (a share-link visitor has no setup).
 *
 *   GET  /api/setup  → SetupView
 *   GET  /api/setup/computers → ComputersView  this computer, plus the account's other computers (devices) with online state
 *   PUT  /api/setup  { tools?: Tool[], plan?: PlanId | null, done?: boolean } → SetupView
 *   GET  /api/setup/ai[?fresh=1]       → LocalAiView   the AI CLIs found on this computer (owner only; fresh reads them again)
 *   POST /api/setup/ai/signin  { id }  → SignInResult  starts the tool's own sign-in (the three CLIs, Grok, Meta, Cursor); its browser opens (CT_LOCAL=1)
 *   POST /api/setup/ai/connect { id, device } → ConnectResult connects it as this account's AI after a real check (always 200)
 *   POST /api/setup/ai/mcp     { id }  → McpResult     adds Creator Toolset to it, with one new Full key (CT_LOCAL=1)
 *   POST /api/setup/ai/install { id }  → SignInResult  installs it (the three CLIs, Grok, Meta, Cursor) by the vendor's own route, then checks it runs (CT_LOCAL=1)
 *   POST /api/setup/join { link }      → { ok, server, device } joins another server behind its one-time link (not hosted)
 */

interface Saved {
  tools?: Tool[];
  /** Home tiles the person switched off under Settings → Tools; every other one shows. Absent = none hidden. */
  hidden?: HomeTile[];
  plan?: PlanId;
  done?: boolean;
  mcpTo?: CliId[];
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
  if (deviceTranscribes()) have.push("deviceTranscripts");
  // the Workshop's own check (workshop.ts workshopAi): its route, an admin's workspace AI included
  if (connectedOwn(u) || !aiFor(user, "workshop", "Workshop").off) have.push("ownAi");
  if ((await ownedProjects(u)).length) have.push("project");
  if (
    readConnectors(u).accounts.some(
      (a) => a.platform === "instagram" && a.via === "login",
    )
  )
    have.push("instagram");
  if (publicApifyStatus(await readApify(u)).configured) have.push("apify");
  ensureLibrary(u);
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

async function view(user: SessionUser): Promise<SetupView> {
  const s = read(user.username) ?? {};
  // a plug-in's other way to set up a tool: its row names it, and counts it once this account has it
  const plugged = await pluginNeeds(user);
  return {
    // a saved id the app no longer has (a tool that left it) is left out: the page sends these lists back whole, and
    // a save with an unknown id in it is refused
    tools: s.tools ? s.tools.filter(isTool) : null,
    hidden: (s.hidden ?? []).filter(isHomeTile),
    plan: s.plan ?? null,
    detected: planOf(user.username),
    done: !!s.done,
    have: [...(await haveFor(user)), ...plugged.have],
    mcpTo: s.mcpTo ?? [],
    ...(plugged.ways.length ? { ways: plugged.ways } : {}),
  };
}

export const setupApp = new Hono<{ Variables: AuthVars }>();

setupApp.use("*", async (c, next) =>
  fileOf(c.get("user").username) && c.get("user").role !== "visitor"
    ? next()
    : c.json({ error: "Sign in with an account to set up" }, 403),
);

setupApp.get("/", async (c) => c.json(await view(c.get("user"))));

/**
 * Connect and Agents: this computer (its name, and whether it is on the account through the relay) and the computers
 * that report to this account (devices, with what each one's CLIs report). The relay's account list needs the account
 * token, which this server does not keep, so it is not listed here (the Mac app holds it).
 */
setupApp.get("/computers", async (c) => {
  const u = c.get("user").username;
  const s = connectState();
  const others = listDevices((d) => d.owner === u).map((d) => ({
    id: d.id,
    name: d.name,
    online: isOnline(d.id),
    drivers: d.report?.drivers ?? [],
  }));
  // a hosted server is shared: only its admin sees the machine's own name and address
  const hide = hostedMode() && c.get("user").role !== "admin";
  return c.json({
    here: hide ? { name: "This server", linked: !!s, hostname: null } : { name: s?.name ?? hostname(), linked: !!s, hostname: s?.hostname ?? null },
    others,
  });
});

/** "I already have a server": joins another server behind a one-time link it showed (lib/server-join.ts). */
setupApp.post("/join", async (c) => {
  // a hosted server must not fetch addresses on a visitor's say-so, and a request through a tunnel is refused the same way
  if (hostedMode() || viaTunnel(c)) return c.json({ ok: false, message: "Joining a server is done from this computer's own app." }, 403);
  const user = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { link?: unknown } | null;
  const r = await joinServer(b?.link);
  if (!r.ok) return c.json(r, 400);
  saveJoin(user.username, { server: r.server, device: r.device, token: r.token, at: Date.now() });
  return c.json({ ok: true, server: r.server, device: r.device });
});

setupApp.put("/", async (c) => {
  const user = c.get("user");
  const b = (await c.req.json().catch(() => null)) as {
    tools?: unknown;
    hidden?: unknown;
    plan?: unknown;
    done?: unknown;
  } | null;
  if (!b) return c.json({ error: "Send { tools, hidden, plan, done }" }, 400);
  const next = { ...(read(user.username) ?? {}) };
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || !b.tools.every(isTool))
      return c.json({ error: `tools: some of ${TOOLS.join(", ")}` }, 400);
    // an id the page can't show (view leaves it out, so the page never sends it) stays in the file as it was saved
    next.tools = [...TOOLS.filter((t) => (b.tools as Tool[]).includes(t)), ...(next.tools ?? []).filter((t) => !isTool(t))];
  }
  if (b.hidden !== undefined) {
    if (!Array.isArray(b.hidden) || !b.hidden.every(isHomeTile))
      return c.json({ error: `hidden: some of ${HOME_TILES.join(", ")}` }, 400);
    next.hidden = [...HOME_TILES.filter((t) => (b.hidden as HomeTile[]).includes(t)), ...(next.hidden ?? []).filter((t) => !isHomeTile(t))];
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

/* ---- your AI on this Mac (Connect your AI, Settings → Providers) ---- */

/**
 * The AI CLIs on this computer are the owner's: only the owner's own account on a server that runs on a computer
 * (not hosted) can see or connect them. Anyone else's subscription is never run for another account.
 */
const ownComputer = (u: SessionUser): boolean => !hostedMode() && u.role === "admin";
const port = () => Number(process.env.PORT || 3000);
const cliOf = (v: unknown): CliId | null =>
  typeof v === "string" && (CLI_IDS as string[]).includes(v) ? (v as CliId) : null;
const mcpToOf = (u: string): CliId[] => read(u)?.mcpTo ?? [];
/** Connect also takes the other AIs the Mac app runs (local-ai.ts OTHER_AIS); install and sign-in the three CLIs, Grok, Meta and Cursor (VENDOR_AIS). */
const aiOf = (v: unknown): Driver | null => cliOf(v) ?? (typeof v === "string" && Object.keys(OTHER_AIS).includes(v) ? (v as Driver) : null);
const setupAiOf = (v: unknown): Driver | null => cliOf(v) ?? (typeof v === "string" && Object.hasOwn(VENDOR_AIS, v) ? (v as Driver) : null);

setupApp.get("/ai", async (c) => {
  const u = c.get("user").username;
  if (!ownComputer(c.get("user"))) return c.json({ local: false, rows: [] } satisfies LocalAiView);
  return c.json(await localAiView(u, mcpToOf(u), c.req.query("fresh") === "1"));
});

setupApp.post("/ai/signin", async (c) => {
  if (!ownComputer(c.get("user"))) return c.json({ ok: false, message: MAC_ONLY }, 403);
  const id = setupAiOf(((await c.req.json().catch(() => null)) as { id?: unknown } | null)?.id);
  if (!id) return c.json({ error: "Pick an AI this Mac can set up" }, 400);
  return c.json(await signIn(id));
});

setupApp.post("/ai/connect", async (c) => {
  if (!ownComputer(c.get("user"))) return c.json({ state: "mac", signedIn: null, answered: null, message: MAC_ONLY });
  const b = (await c.req.json().catch(() => null)) as { id?: unknown; device?: unknown } | null;
  const id = aiOf(b?.id);
  if (!id) return c.json({ error: "Pick Claude Code, Codex or Gemini CLI" }, 400);
  // device: this Mac's own id on this server (the Mac app's page reports it); the check runs through that Mac only
  return c.json(await connectCli(c.get("user").username, id, undefined, typeof b?.device === "string" ? b.device : undefined));
});

setupApp.post("/ai/install", async (c) => {
  if (!ownComputer(c.get("user"))) return c.json({ ok: false, message: MAC_ONLY }, 403);
  const id = setupAiOf(((await c.req.json().catch(() => null)) as { id?: unknown } | null)?.id);
  if (!id) return c.json({ error: "Pick an AI this Mac can set up" }, 400);
  return c.json(await installCli(id));
});

setupApp.post("/ai/update", async (c) => {
  if (!ownComputer(c.get("user"))) return c.json({ ok: false, message: MAC_ONLY }, 403);
  const id = cliOf(((await c.req.json().catch(() => null)) as { id?: unknown } | null)?.id);
  if (!id) return c.json({ error: "Pick Claude Code or Codex" }, 400);
  return c.json(await updateCli(id));
});

setupApp.post("/ai/mcp", async (c) => {
  if (!ownComputer(c.get("user"))) return c.json({ ok: false, added: [], failed: [], message: MAC_ONLY }, 403);
  const u = c.get("user").username;
  const id = cliOf(((await c.req.json().catch(() => null)) as { id?: unknown } | null)?.id);
  if (!id) return c.json({ error: "Pick Claude Code or Codex" }, 400);
  const { result, mcpTo } = await addMcp(u, id, mcpToOf(u), port());
  // the targets are kept even when one failed, so the next add (or Try again) rewrites them too
  write(u, { ...(read(u) ?? {}), mcpTo });
  return c.json(result);
});
