import { randomBytes } from "node:crypto";
import { homedir, release } from "node:os";
import { Hono } from "hono";
import type { ProvidersView } from "../contracts/providers";
import type { AuthVars } from "./auth";
import { viewFor } from "./providers";
import { serverKind } from "./lib/env";
import { lastSignIns } from "./lib/local-ai";
import { base, pingUrl, recentErrors } from "./lib/telemetry";
import type { SessionUser } from "./users";

/**
 * Report a problem (owner, 2026-11-23: "when somebody is stuck… submits a bug report and pulls in all the information
 * that we need to fix it"). The person's own words (a bug, a feature request, anything else) plus what this server knows
 * about why it might not work, sent to the maintainers (creatortoolset.com, POST /api/ping/report) only when the person
 * presses Send: the assistant's report_bug tool (api/mcp.ts) and the account menu's Report a problem dialog both show it
 * first. Any build sends it, the downloaded app or not: it is the person's own message, not a usage report.
 *
 * What it carries beyond their words: the app's version, the system, the server's kind, each AI provider this account
 * sees (kind, on or off, model, its last test with the error), each of its computers (Mac app version, online, the AI
 * programs found there, signed in or not, with plan), the last sign-ins started here with how they ended, and the last
 * errors. No key, no name of a computer or provider, no file or folder name: a home folder is written ~.
 */
export const KINDS = ["bug", "feature", "other"] as const;
const LIMITS = { title: 200, what: 8000, steps: 4000, expected: 2000, context: 12_000, page: 1000 } as const;
const MAX_BYTES = 60_000;

/** A home folder, this server's or a Mac's (/Users/<name>, /home/<name>), as ~. */
export const unhome = (s: string): string => s.split(homedir()).join("~").replace(/\/(?:Users|home)\/[^/\s'"]+/g, "~");

/** What this account's providers and computers say, as the report carries it. */
export function diagnosticsOf(view: ProvidersView, username: string, now = Date.now()) {
  const computers = view.devices.map((d) => d.id);
  const computerOf = (id?: string) => (id ? computers.indexOf(id) + 1 || "not this account's" : "none picked");
  const providers = [
    ...(view.own?.instances ?? []).map((i) => ({ scope: "own" as const, i })),
    ...(view.workspace?.settings.instances ?? []).map((i) => ({ scope: "team" as const, i })),
  ].map(({ scope, i }) => {
    const check = view.checks[`${scope === "own" ? username : "workspace"}:${i.id}`];
    return {
      scope,
      driver: i.driver,
      on: i.enabled,
      model: i.model,
      effort: i.effort,
      accountFolder: i.home ? unhome(i.home) : "default",
      program: i.binaryPath ? unhome(i.binaryPath) : "default",
      computer: computerOf(i.device),
      lastTest: check && { ok: check.ok, minutesAgo: Math.round((now - check.at) / 60_000), seconds: check.ms / 1000, ...(check.error ? { error: unhome(check.error) } : {}), ...(check.note ? { note: check.note } : {}) },
    };
  });
  const devices = view.devices.map((d, n) => ({
    computer: n + 1,
    online: d.online,
    macApp: d.version,
    lastSeenMinutesAgo: d.lastSeen ? Math.round((now - d.lastSeen) / 60_000) : undefined,
    system: d.report?.machine && { os: d.report.machine.os, cpu: d.report.machine.cpu, memGb: d.report.machine.memGb, freeGb: d.report.machine.freeGb },
    reportedMinutesAgo: d.report ? Math.round((now - d.report.at) / 60_000) : undefined,
    ai: d.report?.drivers.map((x) => ({ driver: x.driver, installed: x.installed, version: x.version, signedIn: x.signedIn, plan: x.plan })),
    accountFolders: d.report?.homes.map((h) => ({ driver: h.driver, folder: unhome(h.home), ...(h.customEndpoint ? { customEndpoint: true } : {}) })),
  }));
  const signIns = [...lastSignIns].map(([driver, s]) => ({
    driver,
    minutesAgo: Math.round((now - s.at) / 60_000),
    ended: s.ended === undefined ? "still running" : s.code === 0 ? "exit 0" : `exit ${s.code ?? s.signal}`,
    output: unhome(s.out).trim(),
  }));
  const errors = recentErrors.map((e) => ({ minutesAgo: Math.round((now - e.at) / 60_000), where: e.where, message: e.message }));
  return { providers, using: view.using, computers: devices, signIns, errors };
}

type Body = { kind?: unknown; title?: unknown; what?: unknown; steps?: unknown; expected?: unknown; context?: unknown; page?: unknown; send?: unknown };

/** The report as it would be sent, or the sentence that says what is missing or too long. */
export function reportOf(b: Body, user: SessionUser, diagnostics: ReturnType<typeof diagnosticsOf>, ref: string) {
  const kind = KINDS.includes(b.kind as (typeof KINDS)[number]) ? (b.kind as (typeof KINDS)[number]) : b.kind === undefined ? "bug" : null;
  if (!kind) return "kind is bug, feature or other";
  const text: Partial<Record<keyof typeof LIMITS, string>> = {};
  for (const [k, max] of Object.entries(LIMITS) as Array<[keyof typeof LIMITS, number]>) {
    const v = b[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return `${k} must be text`;
    if (v.length > max) return `${k} is longer than ${max} characters`;
    text[k] = v.trim();
  }
  if (!text.what) return "what is required: the person's own words";
  return {
    ref,
    kind,
    title: text.title || text.what.split("\n")[0]!.slice(0, 120),
    ...text,
    ...base(),
    system: release(),
    server: serverKind(),
    role: user.role,
    ...diagnostics,
  };
}

export const bugReportApp = new Hono<{ Variables: AuthVars }>();

// what a report would carry besides the person's words: the dialog shows it under "What is sent"
bugReportApp.get("/", async (c) => c.json(diagnosticsOf(await viewFor(c.get("user")), c.get("user").username)));

/** `send: true` sends it and answers its ref; without, answers the report as it would go, for the person to read first. */
bugReportApp.post("/", async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES) return c.json({ error: "Too large" }, 413);
  const b = (await c.req.json().catch(() => null)) as Body | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the report as JSON" }, 400);
  const user = c.get("user");
  const report = reportOf(b, user, diagnosticsOf(await viewFor(user), user.username), randomBytes(4).toString("hex"));
  if (typeof report === "string") return c.json({ error: report }, 400);
  const body = JSON.stringify(report);
  if (body.length > MAX_BYTES) return c.json({ error: "The report is too long: shorten the text" }, 413);
  if (b.send !== true) return c.json({ sent: false, report });
  const r = await fetch(`${pingUrl()}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r?.ok) return c.json({ error: "Could not send the report. Check the internet connection and try again." }, 502);
  return c.json({ sent: true, ref: report.ref });
});
