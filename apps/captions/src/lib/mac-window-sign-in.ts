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
/** How long the sign-in page waits on the Mac app before it shows: the app asks the account server, which may be away. */
export const WINDOW_SIGN_IN_WAIT_MS = 5000;

/**
 * True when the Mac app signed this window in, so the page loads again signed in. Asked at most once a minute for a
 * window, so a sign-in that did not hold never loops: the sign-in page shows then. Outside the Mac app, in an older one
 * (it answers "off"), for a server the app's account never signed in to, or when the app has not answered in
 * `waitMs` (the account server is slow or away, and a blank window helps nobody): false.
 */
export async function macSignsWindowIn(now = Date.now(), ask: Bridge | undefined = bridge(), store = sessionStore(), waitMs = WINDOW_SIGN_IN_WAIT_MS): Promise<boolean> {
  if (!ask) return false;
  if (now - Number(store?.getItem(KEY) ?? 0) < 60_000) return false;
  store?.setItem(KEY, String(now));
  try {
    const late = new Promise<{ state?: string }>((done) => setTimeout(() => done({}), waitMs));
    return (await Promise.race([ask.postMessage("window"), late])).state === "signedIn";
  } catch {
    return false;
  }
}
