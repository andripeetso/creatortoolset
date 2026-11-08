import { create } from "zustand";
import type { Tool } from "@contracts/tools";
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
  /** Apps switched off for this account (see canUse). */
  off: Tool[];
  logins?: number | null; // real accounts only — used to spot a first login
}

/** Cloud transcription and AI in Caption Studio. */
export const canUseCloud = (me: Me | null): boolean => !!me;
/** An app is on unless switched off for this account; admins have every one. The server enforces the same for the
 *  apps boot.ts gates. */
export const canUse = (me: Me | null, tool: Tool): boolean =>
  !!me && (me.role === "admin" || !me.off.includes(tool));

interface AuthState {
  required: boolean;
  me: Me | null;
  setAuth: (required: boolean, me: Me | null) => void;
}

export const useAuth = create<AuthState>((set) => ({
  required: false,
  me: null,
  setAuth: (required, me) => set({ required, me }),
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
