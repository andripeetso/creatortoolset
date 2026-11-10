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
  logins?: number | null; // real accounts only — used to spot a first login
  /** The picture from a linked Google or GitHub sign-in (its own URL); null: the initial is shown. */
  picture?: string | null;
}

/** Cloud transcription and AI in Caption Studio. */
export const canUseCloud = (me: Me | null): boolean => !!me;
/** An app or a plug-in gate is on unless switched off for this account; admins have every one. The server enforces
 *  the same for the apps boot.ts gates and for a plug-in's requireGate routes. */
export const canUse = (me: Me | null, tool: Tool | PluginGateId): boolean =>
  !!me && (me.role === "admin" || !me.off.includes(tool));

/** A Home tile: a tool, or the Screen Recorder, which is open to whoever can use Review or Video Notes (where a recording goes). */
export const canUseTile = (me: Me | null, tile: HomeTile): boolean =>
  tile === "record" ? canUse(me, "review") || canUse(me, "notes") : canUse(me, tile);

interface AuthState {
  required: boolean;
  me: Me | null;
  /** The server runs in hosted mode (CT_MODE=hosted): teams, admin, view-as and invite links exist. */
  hosted: boolean;
  /** Set while a platform admin reads the app as `me` (view-as): that admin's username. */
  viewedBy: string | null;
  /** `server` comes from /api/auth/check; a sign-in leaves `hosted` as it was. */
  setAuth: (required: boolean, me: Me | null, server?: { hosted: boolean; viewedBy: string | null }) => void;
}

export const useAuth = create<AuthState>((set) => ({
  required: false,
  me: null,
  hosted: false,
  viewedBy: null,
  setAuth: (required, me, server) =>
    set((s) => ({ required, me, hosted: server?.hosted ?? s.hosted, viewedBy: server?.viewedBy ?? null })),
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
