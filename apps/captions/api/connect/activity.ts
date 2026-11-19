import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { onAttention, type Attention } from "../lib/attention";
import { onEvent, type CoreEvents } from "../lib/events";
import { findUser } from "../users";
import { signJws } from "./keys";
import { connectState, saveConnectState } from "./state";

/**
 * Phone notifications through the connect service. When something starts to wait on the person this computer is linked
 * for (an AI Editor cut ready for review, an edit waiting on them, a job that failed, the assistant asking them
 * something, a final delivered), the computer signs a short note with its own key and hands it to the connect service,
 * which sends it to the phones signed in to the same account (apps/relay/src/push.ts). The note is a title, one line
 * and the page a tap opens: never media, never chat text. Off with the "Send notifications to your phones" switch
 * (`notifyPhones` in connect.json, on unless turned off), and off when this computer is not linked.
 */

export const ACTIVITY_TYP = "ct-activity+jwt";
export type ActivityKind = "review" | "go" | "failed" | "asks" | "final";
export interface Activity {
  serverId: string;
  workspace?: string;
  kind: ActivityKind;
  title: string;
  headline: string;
  path: string;
  at: string;
}

const PROOF_LIFE = 60; // seconds
const SAME_WITHIN_MS = 60_000; // one run can end on two steps at once: the same note twice in a minute is sent once

/** The switch: on while linked, unless the owner turned it off. */
export const phonesNotified = (): boolean => {
  const s = connectState();
  return !!s && s.notifyPhones !== false;
};

/** Tests replace `fetch`, so no test reaches a connect service. */
export const io = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const recent = new Map<string, number>();

/**
 * Tells the account's phones that something waits on `owner`. Only the person this computer was linked by: a team
 * member's work on it is not the account owner's news. Resolves to whether the connect service took it; never throws.
 */
export async function publishActivity(owner: string, a: Omit<Activity, "serverId" | "at">): Promise<boolean> {
  const s = connectState();
  if (!s || s.notifyPhones === false || owner !== s.localUser) return false;
  const activity: Activity = {
    serverId: s.computerId,
    ...(a.workspace ? { workspace: a.workspace } : {}),
    kind: a.kind,
    title: oneLine(a.title, 120) || "Creator Toolset",
    headline: oneLine(a.headline, 200) || "Waiting for you",
    path: a.path,
    at: new Date().toISOString(),
  };
  const key = `${activity.kind} ${activity.path} ${activity.headline}`;
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > SAME_WITHIN_MS) recent.delete(k);
  if (recent.has(key)) return false;
  recent.set(key, now);
  const iat = Math.floor(now / 1000);
  const proof = signJws(ACTIVITY_TYP, {
    iss: `ct-computer:${s.computerId}`,
    aud: new URL(s.brokerUrl).origin,
    jti: randomUUID(),
    iat,
    exp: iat + PROOF_LIFE,
    activity,
  });
  try {
    const r = await io.fetch(new URL(`/v1/computers/${s.computerId}/activity`, s.brokerUrl).href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false; // a missed notification is not worth more: the phone's list still shows it
  }
}

/** The assistant asks something (an Allow / Deny, a Yes / No, a key), or its reply failed. Its words stay in the chat. */
export function fromAttention(a: Attention): Omit<Activity, "serverId" | "at"> | null {
  if (a.kind === "done") return null;
  const headline =
    a.kind === "failed" ? "A reply didn't finish" : a.body.startsWith("Needs approval") ? "Needs your approval" : /^Needs the .{1,40} key$/.test(a.body) ? a.body : "Asks you something";
  return { kind: a.kind, title: "Assistant", headline, path: a.path };
}

export const fromWaiting = (w: CoreEvents["waiting"]): Omit<Activity, "serverId" | "at"> => ({
  kind: w.kind,
  title: w.title,
  headline: w.headline,
  path: w.path,
  ...(w.workspace ? { workspace: w.workspace } : {}),
});

onAttention((a) => {
  const note = fromAttention(a);
  if (note) return publishActivity(a.username, note).then(() => {});
});
onEvent("waiting", (w) => publishActivity(w.owner, fromWaiting(w)));

// GET / POST /api/connect/notifications { on }: the switch, for Settings. Only the owner, as for the rest of Connect.
export const phoneNotifyApp = new Hono<{ Variables: AuthVars }>();
phoneNotifyApp.use("/notifications", async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin" || !findUser(user.username)) return c.json({ error: "Only the owner can change this" }, 403);
  return next();
});
phoneNotifyApp.get("/notifications", (c) => c.json({ linked: !!connectState(), on: phonesNotified() }));
phoneNotifyApp.post("/notifications", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return c.json({ error: "on must be true or false" }, 400);
  const s = connectState();
  if (!s) return c.json({ error: "This computer is not connected to your account" }, 409);
  saveConnectState({ ...s, notifyPhones: body.on });
  return c.json({ linked: true, on: body.on });
});
