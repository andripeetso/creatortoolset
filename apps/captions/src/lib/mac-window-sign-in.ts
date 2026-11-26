// A server's sign-in page in the Mac app: the app signs this window in through its own Creator Toolset account when it
// can (apps/mac Shell.swift signInWithAccount; api/auth-clients.ts POST /api/auth/account-ticket). Kept apart from the
// account screens so the sign-in gate, which every page loads, takes nothing else with it.

type Bridge = { postMessage: (m: string) => Promise<{ state?: string }> };
const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { webkit?: { messageHandlers?: { account?: Bridge } } }).webkit?.messageHandlers?.account;
const sessionStore = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
const KEY = "ct-window-sign-in";

/**
 * True when the Mac app signed this window in, so the page loads again signed in. Asked at most once a minute for a
 * window, so a sign-in that did not hold never loops: the sign-in page shows then. Outside the Mac app, in an older one
 * (it answers "off"), or for a server the app's account never signed in to: false.
 */
export async function macSignsWindowIn(now = Date.now(), ask: Bridge | undefined = bridge(), store = sessionStore()): Promise<boolean> {
  if (!ask) return false;
  if (now - Number(store?.getItem(KEY) ?? 0) < 60_000) return false;
  store?.setItem(KEY, String(now));
  try {
    return (await ask.postMessage("window")).state === "signedIn";
  } catch {
    return false;
  }
}
