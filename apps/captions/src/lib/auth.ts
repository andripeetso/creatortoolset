import { create } from "zustand";
import type { HomeTile, PluginGateId, Tool } from "@contracts/tools";
import { clearLocalCache } from "./local-cache";

/**
 * Client-side view of the logged-in account. Populated by AuthGate on
 * startup (and after login); read anywhere via useAuth. When the
 * server runs without APP_SECRET, `required` is false and `me` is a
 * local admin stand-in.
 */

export interface Me {
  username: string;
  /** The display name (Settings → Account); the username when none is set. */
  name?: string;
  role: "admin" | "team" | "user";
  cloud: boolean;
  /** Apps and plug-in gates switched off for this account (see canUse). */
  off: (Tool | PluginGateId)[];
  /** Apps it opens but doesn't change (Settings → Team → Access: Read); the server refuses their writes. */
  read?: Tool[];
  /** a member of someone else's team: never deletes the owner's footage or finals (the server refuses it) */
  member?: true;
  logins?: number | null; // real accounts only — used to spot a first login
  /**
   * The server on this Mac made this account's password and showed it to nobody (api/auth.ts passwordIsAppMade): the
   * person has nothing to sign in with, so no password rows and no Sign out.
   */
  noPassword?: true;
  /** The picture from a linked Google or GitHub sign-in (its own URL); null: the initial is shown. */
  picture?: string | null;
}

/** Cloud transcription and AI in Caption Studio. */
export const canUseCloud = (me: Me | null): boolean => !!me;
/** An app or a plug-in gate is on unless switched off for this account; admins have every one. The server enforces
 *  the same for the apps boot.ts gates and for a plug-in's requireGate routes. A plug-in off in the workspace this window
 *  is in (setOffHere) is off for everyone, admins too: its server routes refuse there (api/lib/plugin-workspaces.ts). */
export const canUse = (me: Me | null, tool: Tool | PluginGateId): boolean =>
  !!me && !offHere.includes(tool) && (me.role === "admin" || !me.off.includes(tool));

let offHere: string[] = [];
/** The plug-ins (by id and gate) off in the workspace this window is in; set on each switch (workspace.ts). */
export function setOffHere(ids: string[]): void {
  if (ids.join() === offHere.join()) return;
  offHere = ids;
  // a new `me` draws again whatever reads canUse
  const me = useAuth.getState().me;
  if (me) useAuth.setState({ me: { ...me } });
}
export const pluginOffHere = (id: string): boolean => offHere.includes(id);
/** The app is on and not set to Read: this account may change things there, so its edit controls show. */
export const canChange = (me: Me | null, tool: Tool): boolean => canUse(me, tool) && (me!.role === "admin" || !me!.read?.includes(tool));

/** A Home tile: a tool, or the Screen Recorder, which is open to whoever can use Review or Video Notes (where a recording goes). */
export const canUseTile = (me: Me | null, tile: HomeTile): boolean =>
  tile === "record" ? canUse(me, "review") || canUse(me, "notes") : canUse(me, tile);

export type { ServerKind } from "@contracts/work";
import type { ServerKind } from "@contracts/work";
/** The server has accounts and a team (a Server or Creator Toolset Cloud). */
export const hasTeam = (kind: ServerKind): boolean => kind !== "mac";
/** Whether this person signs in and out here: the server asks for a sign-in, and they have one of their own to give. */
export const signsIn = (required: boolean, me: Me | null): boolean => required && !me?.noPassword;

interface AuthState {
  required: boolean;
  me: Me | null;
  /** What the server is (/api/auth/check `kind`): a Server or Cloud has teams, admin and invite links; Cloud view-as. */
  kind: ServerKind;
  /** Set while a platform admin reads the app as `me` (view-as): that admin's username. */
  viewedBy: string | null;
  /** `server` comes from /api/auth/check; a sign-in leaves `kind` as it was. */
  setAuth: (required: boolean, me: Me | null, server?: { kind: ServerKind; viewedBy: string | null }) => void;
}

export const useAuth = create<AuthState>((set) => ({
  required: false,
  me: null,
  kind: "mac",
  viewedBy: null,
  setAuth: (required, me, server) =>
    set((s) => ({ required, me, kind: server?.kind ?? s.kind, viewedBy: server?.viewedBy ?? null })),
}));

/** The signed-in account, reactive. */
export const useMe = (): Me | null => useAuth((state) => state.me);

/**
 * Where to go after signing in: `?next=` on this site, or on a subdomain of this site over https
 * (media.<this host>). Anything else is ignored, so this is never an open redirect.
 */
export function returnTo(search: string, origin: string): string | null {
  const next = new URLSearchParams(search).get("next");
  if (!next) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  const home = new URL(origin);
  const local = (h: string) => h === "localhost" || h === "127.0.0.1";
  const sibling =
    url.protocol === "https:" &&
    !local(home.hostname) &&
    url.hostname.endsWith(`.${home.hostname}`);
  const sameSite =
    url.origin === home.origin ||
    (local(home.hostname) && local(url.hostname) && url.protocol === home.protocol);
  return sibling || sameSite ? url.href : null;
}

export async function logout(): Promise<void> {
  clearLocalCache();
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.reload();
}
