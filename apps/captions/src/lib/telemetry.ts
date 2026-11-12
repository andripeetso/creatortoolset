import { useEffect } from "react";

/**
 * The page's half of the anonymous usage and crash reports (api/lib/telemetry.ts): each page opened, by its first
 * path part only ("/workshop/abc" → "workshop"), and the page's uncaught errors, told to this app's own server, which
 * sends them on only in the downloaded app with the switch on (Settings → General). Asked once per load.
 */
let on: Promise<boolean> | null = null;
const isOn = () =>
  (on ??= fetch("/api/telemetry")
    .then((r) => (r.ok ? (r.json() as Promise<{ on?: boolean }>) : ({} as { on?: boolean })))
    .then((s) => s.on === true)
    .catch(() => false));

const send = (path: string, body: unknown) =>
  void isOn().then((yes) => {
    if (yes) void fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  });

export const pageName = (pathname: string) => pathname.split("/")[1] || "home";

// the browser's own noise and errors from other origins (extensions), which carry nothing to fix
const NOISE = /^(Script error\.?|ResizeObserver loop|.*AbortError)/;

function onError(e: unknown) {
  const err = e instanceof Error ? e : null;
  const message = err?.message ?? String(e);
  if (!message || NOISE.test(message)) return;
  send("/api/telemetry/error", { name: err?.name ?? "Error", message, stack: err?.stack ?? "" });
}

let listening = false;

/** Call once in the app's root with the current path. */
export function useTelemetry(pathname: string): void {
  useEffect(() => {
    if (listening) return;
    listening = true;
    window.addEventListener("error", (e) => onError(e.error ?? e.message));
    window.addEventListener("unhandledrejection", (e) => onError(e.reason));
  }, []);
  const page = pageName(pathname);
  useEffect(() => {
    send("/api/telemetry/view", { page });
  }, [page]);
}
