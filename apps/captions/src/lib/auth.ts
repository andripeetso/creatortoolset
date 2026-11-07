import { useMemo } from "react";
import { create } from "zustand";
import { TOOLS, type Tool } from "@contracts/tools";

/**
 * Client-side view of the logged-in account. Populated by AuthGate on
 * startup (and after login); read anywhere via useAuth. When the
 * server runs without APP_SECRET, `required` is false and `me` is a
 * local admin stand-in.
 */

export interface Me {
  username: string;
  role: "admin" | "team" | "user" | "guest";
  cloud: boolean;
  /** Apps an admin switched off for this account (see canUse). */
  off: Tool[];
  logins?: number | null; // real accounts only — used to spot a first login
  /** "See the demo": the demo account, read-only (the server refuses every change). */
  demo?: boolean;
}

/**
 * Admin-only UI previews of the other roles; they never replace the
 * authenticated server identity.
 */
export type ViewAsRole = "guest" | "user";

export interface ViewAsOption {
  id: ViewAsRole;
  label: string;
  description: string;
  role: Me["role"];
  off: Tool[];
}

export const VIEW_AS_OPTIONS: readonly ViewAsOption[] = [
  {
    id: "guest",
    label: "Guest",
    description: "Caption Studio with AI, Review and the Audio Enhancer, capped · nothing kept long",
    role: "guest",
    off: TOOLS.filter((t) => t !== "captions" && t !== "stories" && t !== "review" && t !== "enhance"),
  },
  {
    id: "user",
    label: "User",
    description: "A new account: every app",
    role: "user",
    off: [],
  },
] as const;

export function viewAsOption(role: ViewAsRole | null): ViewAsOption | null {
  return VIEW_AS_OPTIONS.find((option) => option.id === role) ?? null;
}

/** The identity UI feature gates should see while an admin is previewing. */
export function viewedMe(me: Me | null, viewAs: ViewAsRole | null): Me | null {
  const option = viewAsOption(viewAs);
  if (!me || me.role !== "admin" || !option) return me;
  return { ...me, role: option.role, off: option.off };
}

/** Guest sessions are ephemeral: nothing persists server-side. */
export const isGuest = (me: Me | null): boolean => me?.role === "guest";
/** A "See the demo" visitor: sees the demo account, changes nothing. */
export const isDemo = (me: Me | null): boolean => !!me?.demo;
/** Cloud transcription and AI in Caption Studio (guests too, capped: api/guest.ts). */
export const canUseCloud = (me: Me | null): boolean => !!me;
/** An app is on unless an admin switched it off for this account; admins
 *  have every one (guests get Caption Studio and Story Splitter). The
 *  server enforces the same for the apps boot.ts gates. */
export const canUse = (me: Me | null, tool: Tool): boolean =>
  !!me && (me.role === "admin" || !me.off.includes(tool));

interface AuthState {
  required: boolean;
  me: Me | null;
  viewAs: ViewAsRole | null;
  setAuth: (required: boolean, me: Me | null) => void;
  setViewAs: (viewAs: ViewAsRole | null) => void;
}

export const useAuth = create<AuthState>((set) => ({
  required: false,
  me: null,
  viewAs: null,
  setAuth: (required, me) =>
    set((state) => ({
      required,
      me,
      // A preview is never allowed to outlive the admin identity that
      // started it (for example after logout/login in another tab).
      viewAs: me?.role === "admin" ? state.viewAs : null,
    })),
  setViewAs: (viewAs) =>
    set((state) => ({
      viewAs: state.me?.role === "admin" ? viewAs : null,
    })),
}));

/** Reactive effective identity for role-dependent presentation. */
export function useViewedMe(): Me | null {
  const me = useAuth((state) => state.me);
  const viewAs = useAuth((state) => state.viewAs);
  return useMemo(() => viewedMe(me, viewAs), [me, viewAs]);
}

/** Non-reactive effective identity for event handlers and guards. */
export function getViewedMe(): Me | null {
  const { me, viewAs } = useAuth.getState();
  return viewedMe(me, viewAs);
}

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
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.reload();
}
