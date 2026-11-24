import { randomBytes } from "node:crypto";
import { homedir, release } from "node:os";
import { Hono, type MiddlewareHandler } from "hono";
import type { ProvidersView } from "../contracts/providers";
import type { AuthVars } from "./auth";
import { viewFor } from "./providers";
import { isCloud, serverKind } from "./lib/env";
import { lastSignIns } from "./lib/local-ai";
import { base, pingUrl, recentErrors, scrub } from "./lib/telemetry";
import { failuresOf, noteFailure } from "./lib/failures";
import { libraryDb } from "./library/db";
import { VISITOR, type SessionUser } from "./users";

/**
 * Report a problem (owner, 2026-11-23: "when somebody is stuck… submits a bug report and pulls in all the information
 * that we need to fix it"). The person's own words (a bug, a feature request, anything else) plus what this server knows
 * about why it might not work, sent to the maintainers (creatortoolset.com, POST /api/ping/report) only when the person
 * presses Send: the assistant's report_bug tool (api/mcp.ts) and the account menu's Report a problem dialog both show it
 * first. Any build sends it, the downloaded app or not: it is the person's own message, not a usage report.
 *
 * What it carries beyond their words: the app's version, the system, the server's kind, each AI provider this account
 * sees (kind, on or off, model, its last test with the error), each of its computers (Mac app version, online, the AI
 * programs found there, signed in or not, with plan), what failed for this account lately (lib/failures.ts: requests the
 * server answered with an error, work that ended failed), the failed library jobs and computer tasks it started, from the assistant the chat up to the report, and on a server
 * the person owns (This Mac, or an admin's own server) the last sign-ins started here, the server's last errors with the
 * top of their stack, and every account's failed jobs: those are the whole server's, so a team member or a Cloud account
 * never gets them. No key, no name of a computer or provider: a home folder is written ~, a path in an error <path>.
 * Error messages go as the app showed them, so one can name a file; the dialog shows all of it before Send.
 */
export const KINDS = ["bug", "feature", "other"] as const;
const LIMITS = { title: 200, what: 8000, steps: 4000, expected: 2000, context: 12_000, page: 1000 } as const;
const CHAT_MESSAGES = 30;
const CHAT_TEXT = 2000;
/** The site takes 64 KB (plugins/hosted ping.ts); bytes, not characters: most letters outside English take two or three. */
const MAX_BYTES = 60_000;

/** A home folder, this server's or a Mac's (/Users/<name>, /home/<name>), as ~. */
export const unhome = (s: string): string => s.split(homedir()).join("~").replace(/\/(?:Users|home)\/[^/\s'"]+/g, "~");

/** What this account's providers and computers say, as the report carries it. */
/** The server's own errors and sign-ins are the owner's to see: This Mac's person, or an admin of their own server. */
export const ownsServer = (u: SessionUser): boolean => !isCloud() && u.role === "admin";

export function diagnosticsOf(view: ProvidersView, username: string, owner: boolean, now = Date.now()) {
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
  const signIns = [...(owner ? lastSignIns : [])].map(([driver, s]) => ({
    driver,
    minutesAgo: Math.round((now - s.at) / 60_000),
    ended: s.ended === undefined ? "still running" : s.code === 0 ? "exit 0" : `exit ${s.code ?? s.signal}`,
    output: unhome(s.out).trim(),
  }));
  const errors = (owner ? recentErrors : []).map((e) => ({ minutesAgo: Math.round((now - e.at) / 60_000), where: e.where, message: e.message, ...(e.stack ? { stack: e.stack } : {}) }));
  return { providers, using: view.using, computers: devices, signIns, errors, failedRequests: failuresOf(username, "request", now), failedWork: failuresOf(username, "work", now) };
}

/** Mounted after the account gate (boot.ts): each signed-in request answered 400 or more, with its error line. */
export const noteFailures: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await next();
  const u = c.get("user");
  const { status } = c.res;
  if (status < 400 || !u || u.role === VISITOR.role || /^\/api\/(bug-report|telemetry)/.test(c.req.path)) return;
  const type = c.res.headers.get("content-type") ?? "";
  const note = (error?: string) => noteFailure(u.username, "request", `${c.req.method} ${unhome(c.req.path)}`, { status, error });
  if (!/json|text\/plain/.test(type)) return note();
  // read off a copy, so the answer is not held up
  void c.res
    .clone()
    .text()
    .then((t) => {
      const e = type.includes("json") ? (JSON.parse(t) as { error?: unknown }).error : t;
      note(typeof e === "string" ? e : e === undefined ? undefined : JSON.stringify(e));
    })
    .catch(() => note());
};

/** The failed library jobs and computer tasks, alike ones counted together: an owner's whole server's, else the person's own. */
export function failedJobsOf(username: string, owner: boolean, now = Date.now()) {
  const who = owner ? "" : " AND actor = ?";
  type Row = { kind: string; error: string | null; n: number; at: number | null };
  const read = (sql: string): Row[] => {
    try {
      return libraryDb().prepare(sql).all(...(owner ? [] : [username])) as Row[];
    } catch {
      return []; // computer_tasks is made on its first use
    }
  };
  const group = `GROUP BY kind, error ORDER BY at DESC LIMIT 10`;
  return [
    ...read(`SELECT kind, error, COUNT(*) AS n, MAX(COALESCE(done_at, started_at)) AS at FROM jobs WHERE state = 'failed'${who} ${group}`).map((r) => ({ where: "library", ...r })),
    ...read(`SELECT kind, error, COUNT(*) AS n, MAX(created_at) AS at FROM computer_tasks WHERE state = 'failed'${who} ${group}`).map((r) => ({ where: "computer", ...r })),
  ].map((r) => ({ where: r.where, kind: r.kind, ...(r.error ? { error: scrub(r.error).slice(0, 300) } : {}), count: r.n, ...(r.at ? { minutesAgo: Math.round((now - r.at) / 60_000) } : {}) }));
}

/** Everything a report carries besides the person's words: the dialog shows all of it under "What is sent". */
async function detailsFor(u: SessionUser) {
  const owner = ownsServer(u);
  return { ...base(), system: release(), server: serverKind(), role: u.role, ...diagnosticsOf(await viewFor(u), u.username, owner), failedJobs: failedJobsOf(u.username, owner) };
}

type Body = { kind?: unknown; title?: unknown; what?: unknown; steps?: unknown; expected?: unknown; context?: unknown; page?: unknown; chat?: unknown; send?: unknown };

/** The report as it would be sent, or the sentence that says what is missing or too long. */
export function reportOf(b: Body, details: object, ref: string) {
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
  const chat = Array.isArray(b.chat)
    ? b.chat.slice(-CHAT_MESSAGES).flatMap((m) => {
        const { role, text: t } = (m ?? {}) as { role?: unknown; text?: unknown };
        return typeof t === "string" && t.trim() ? [{ role: role === "user" ? "user" : "assistant", text: t.slice(0, CHAT_TEXT) }] : [];
      })
    : [];
  return {
    ref,
    kind,
    title: text.title || text.what.split("\n")[0]!.slice(0, 120),
    ...text,
    ...(chat.length ? { chat } : {}),
    ...details,
  };
}

/** The lists a report gives up first when it is too big for the site, the oldest of the biggest one at a time. */
const TRIM = ["chat", "errors", "failedRequests", "failedWork", "failedJobs", "signIns"] as const;

/** The report as JSON within MAX_BYTES: the details are cut (marked `trimmed`), never the person's words; null when those alone are too long. */
export function fit(report: Record<string, unknown>, max = MAX_BYTES): string | null {
  const r = { ...report };
  let body = JSON.stringify(r);
  while (Buffer.byteLength(body) > max) {
    const k = TRIM.filter((k) => Array.isArray(r[k]) && (r[k] as unknown[]).length).sort((a, b) => JSON.stringify(r[b]).length - JSON.stringify(r[a]).length)[0];
    if (!k) return null;
    r[k] = (r[k] as unknown[]).slice(1);
    r.trimmed = true;
    body = JSON.stringify(r);
  }
  return body;
}

export const bugReportApp = new Hono<{ Variables: AuthVars }>();

bugReportApp.get("/", async (c) => {
  return c.json(await detailsFor(c.get("user")));
});

/** `send: true` sends it and answers its ref; without, answers the report as it would go, for the person to read first. */
bugReportApp.post("/", async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES) return c.json({ error: "Too large" }, 413);
  const b = (await c.req.json().catch(() => null)) as Body | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the report as JSON" }, 400);
  const report = reportOf(b, await detailsFor(c.get("user")), randomBytes(4).toString("hex"));
  if (typeof report === "string") return c.json({ error: report }, 400);
  const body = fit(report);
  if (!body) return c.json({ error: "The report is too long: shorten the text" }, 413);
  if (b.send !== true) return c.json({ sent: false, report: JSON.parse(body) as unknown }); // as trimmed
  const r = await fetch(`${pingUrl()}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r) return c.json({ error: "Could not send the report. Check the internet connection and try again." }, 502);
  if (!r.ok) return c.json({ error: r.status === 429 ? "Could not send the report: too many reports today. Try again tomorrow." : r.status === 413 ? "The report is too long: shorten the text" : "Could not send the report. Try again later." }, 502);
  return c.json({ sent: true, ref: report.ref });
});
