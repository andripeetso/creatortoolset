import type { ConnectedAccount, ConnectorsView, LoginKind, SocialPlatform } from "@contracts/connectors";
import { bodyOf } from "@/lib/body";

export * from "@contracts/connectors";

/** Client for Settings → Social accounts (api/connectors.ts). */
async function json<T>(r: Response): Promise<T> {
  const body = (await bodyOf(r)) as T & { error?: string };
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const getConnectors = () => fetch("/api/connectors").then((r) => json<ConnectorsView>(r));
/** Is this platform's sign-in on right now? Asked when the person presses Add (the server asks the sign-in service then, never before). */
export const loginOffered = (kind: LoginKind) => fetch(`/api/connectors/apps/${kind}`).then((r) => json<{ on: boolean }>(r)).then((r) => r.on);
/** A full-page trip to the platform's login and back to `back`. */
export const loginHref = (kind: LoginKind, opts: { projectId?: string; back?: string; platform?: SocialPlatform } = {}) =>
  `/api/connectors/login/${kind}?${new URLSearchParams({ ...(opts.projectId ? { projectId: opts.projectId } : {}), ...(opts.platform ? { platform: opts.platform } : {}), back: opts.back ?? "/settings/connectors" })}`;
/** The one account to add from a sign-in that returned several (ConnectorsView.choose); dropChoice cancels it. */
export const chooseAccount = (key: string) => fetch("/api/connectors/choose", send("POST", { key })).then((r) => json<ConnectedAccount>(r));
export const dropChoice = () => fetch("/api/connectors/choose", send("DELETE")).then((r) => json<{ ok: true }>(r));
export const addHandle = (platform: SocialPlatform, handle: string, projectId?: string) =>
  fetch("/api/connectors/handles", send("POST", { platform, handle, projectId })).then((r) => json<ConnectedAccount>(r));
export const linkAccount = (key: string, projectId: string | null) =>
  fetch(`/api/connectors/accounts/${encodeURIComponent(key)}`, send("PATCH", { projectId })).then((r) => json<ConnectedAccount>(r));
export const pullAccountNow = (key: string) => fetch(`/api/connectors/accounts/${encodeURIComponent(key)}/pull`, send("POST")).then((r) => json<ConnectedAccount>(r));
export const disconnectAccount = (key: string) => fetch(`/api/connectors/accounts/${encodeURIComponent(key)}`, send("DELETE")).then((r) => json<{ ok: true }>(r));
