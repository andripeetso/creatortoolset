// A pairing link (`https://host/#token=…`, api/connect/contract.md) opened in a browser. The code is for the phone app:
// this page takes it off the address bar at once and never sends it anywhere, so the link still works in the app.

/** The pairing code in a URL on the root page: `#token=` (what the server makes) or `?token=`; null when there is none. */
export function pairingToken(url: URL): string | null {
  if (url.pathname !== "/") return null; // other pages' own query stays theirs
  const t = new URLSearchParams(url.hash.slice(1)).get("token") ?? url.searchParams.get("token");
  return t?.trim() || null;
}

/** The same URL with no code in it, for the address bar and the history. */
export function withoutToken(url: URL): URL {
  const out = new URL(url);
  const hash = new URLSearchParams(out.hash.slice(1));
  hash.delete("token");
  out.hash = hash.toString();
  out.searchParams.delete("token");
  return out;
}

/** The phone app's own link for a pairing link: `creatortoolset://pair?pairingUrl=<https://host/#token=…>`. */
export const appLink = (origin: string, token: string) =>
  `creatortoolset://pair?${new URLSearchParams({ pairingUrl: `${origin}/#token=${token}` })}`;

// shortcut: App Store search, not the listing; swap in the app's apps.apple.com/app/id… link once it is listed
export const APP_STORE_URL = "https://apps.apple.com/search?term=Creator%20Toolset";

/** Called once before the app draws: the code (taken off the address bar), or null for every other page. */
export function takePairingToken(): string | null {
  const url = new URL(window.location.href);
  const token = pairingToken(url);
  if (token) window.history.replaceState(window.history.state, "", withoutToken(url).toString());
  return token;
}
