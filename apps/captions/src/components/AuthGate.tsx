import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Lock, UserRound } from "lucide-react";
import { ToolsetLogo } from "@/components/HomeLink";
import { returnTo, useAuth, type Me } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { JoinPage } from "@/pages/JoinPage";
import { joinToken } from "@/lib/workspaces";
import { siteFrameFor } from "@/lib/plugin";
import { CodeStep } from "@/components/SignInCode";
import { webPlugins } from "@/plugins.gen";

const PUBLIC_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Share links: /clips/<uuid> is viewable without an account. */
export function isPublicClipPath(pathname: string): boolean {
  return new RegExp(`^/clips/${PUBLIC_UUID}/?$`, "i").test(pathname);
}

/** Published documents: /documents/<uuid>. Drafts 404 at the API. */
export function isPublicDocumentPath(pathname: string): boolean {
  return new RegExp(`^/documents/${PUBLIC_UUID}/?$`, "i").test(pathname);
}

/** Media Library share links: /library/s/<token>, viewable without an account. */
export function isPublicLibraryPath(pathname: string): boolean {
  return /^\/library\/s\/[A-Za-z0-9_-]{22}\/?$/.test(pathname);
}

/** A shared Video Notes folder: /clips/f/<token>, viewable without an account. */
export function isPublicClipFolderPath(pathname: string): boolean {
  return /^\/clips\/f\/[A-Za-z0-9_-]{22}\/?$/.test(pathname);
}

export function isPublicSharePath(pathname: string): boolean {
  return isPublicClipPath(pathname) || isPublicClipFolderPath(pathname) || isPublicDocumentPath(pathname);
}

/** Review share links: /r/<token>, and a project's /rp/<token>[/<video>];
 *  Content Workshop share links, /ws/<token>
 *  (a freelancer opens it with no account). Kept out of isPublicSharePath so
 *  the light/dark share theme never touches these (always dark) screens. */
export function isPublicReviewPath(pathname: string): boolean {
  return new RegExp(`^/(?:r/${PUBLIC_UUID}|rp/${PUBLIC_UUID}(?:/${PUBLIC_UUID})?|fs/${PUBLIC_UUID}|ws/${PUBLIC_UUID})/?$`, "i").test(pathname);
}

export type SignInProvider = "apple" | "google" | "github";
export type SignInProviders = Record<SignInProvider, boolean> & { /** false: this server takes no passwords */ password?: boolean };
const PROVIDER_NAME: Record<SignInProvider, string> = { apple: "Apple", google: "Google", github: "GitHub" };

/** The page this login screen stands in for, to come back to after the provider (an error from a try before is dropped). */
function backHere(): string {
  if (typeof window === "undefined") return "/";
  const q = new URLSearchParams(window.location.search);
  q.delete("error");
  const s = q.toString();
  return window.location.pathname + (s ? `?${s}` : "");
}

/** One "Sign in with …" button per provider this server has keys for (api/sign-in.ts, GET /api/account/providers). */
export function ProviderButtons({ providers }: { providers: SignInProviders }) {
  return (
    <>
      {(Object.keys(PROVIDER_NAME) as SignInProvider[])
        .filter((p) => providers[p] === true)
        .map((p) => (
          <a
            key={p}
            href={`/api/account/login/${p}?for=site&next=${encodeURIComponent(backHere())}`}
            className="flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 py-2 text-sm font-medium text-zinc-100 hover:border-violet-500"
          >
            Sign in with {PROVIDER_NAME[p]}
          </a>
        ))}
    </>
  );
}

/** The last answer from /api/auth/check, kept on this device. Under the local-cache prefix, so sign-out clears it. */
const SNAP_KEY = "ct-swr:auth";
type Snap = { required: boolean; user: Me | null; hosted: boolean; viewedBy: string | null };
function readSnap(): Snap | null {
  try {
    const v = JSON.parse(localStorage.getItem(SNAP_KEY) ?? "null");
    return v && typeof v === "object" && v.user ? (v as Snap) : null;
  } catch {
    return null;
  }
}
function writeSnap(s: Snap | null) {
  try {
    if (s) localStorage.setItem(SNAP_KEY, JSON.stringify(s));
    else localStorage.removeItem(SNAP_KEY);
  } catch {
    /* storage off: the check decides on its own */
  }
}

// Before the first render: a returning account's last sign-in, so the app paints on its first frame. The check below
// confirms it, and a server that disagrees sends the page to sign-in.
const snap = readSnap();
if (snap) useAuth.getState().setAuth(snap.required, snap.user, { hosted: snap.hosted, viewedBy: snap.viewedBy });

/**
 * Blocks the app behind an account login when the server has
 * APP_SECRET set (public hosting). Renders children immediately when
 * auth is not required (local use). Public clip share URLs skip the
 * login screen so a pasted clip or published document just opens.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const publicShare = isPublicSharePath(pathname) || isPublicReviewPath(pathname) || isPublicLibraryPath(pathname);
  const [state, setState] = useState<"checking" | "login" | "link" | "ok">(snap ? "ok" : "checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // the sign-in buttons this server offers (null until read); the password form sits behind "Use a password instead"
  const [providers, setProviders] = useState<SignInProviders | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  // a failed sign-in comes back to /login?error=…
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("error") ?? "");
  // a team that signs in with Google / Apple: the providers this account must link first (auth.ts ruleFor)
  const [mustLink, setMustLink] = useState<("apple" | "google")[]>([]);
  // the password was right and the sign-in code comes next (api/auth.ts codeStep): its one-time step token
  const [step, setStep] = useState<{ token: string; setup: boolean } | null>(null);
  const setAuth = useAuth((s) => s.setAuth);
  const hosted = useAuth((s) => s.hosted);
  // /join/<token> is an invite to a team: hosted servers only (elsewhere the path is just an unknown page)
  const invite = joinToken(pathname);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((d: { required: boolean; authed: boolean; user: Me | null; hosted?: boolean; viewedBy?: string | null; mustLink?: ("apple" | "google")[] | null }) => {
        // Signed in with an account and sent here to sign in (?next=): go back.
        const back = returnTo(window.location.search, window.location.origin);
        if (back && d.authed) {
          window.location.replace(back);
          return;
        }
        // a re-check with the same answer leaves the store alone (a new `me` object would re-run the loads keyed on it)
        const next: Snap = { required: d.required, user: d.user, hosted: !!d.hosted, viewedBy: d.viewedBy ?? null };
        const cur = useAuth.getState();
        if (cur.required !== next.required || cur.hosted !== next.hosted || cur.viewedBy !== next.viewedBy || JSON.stringify(cur.me) !== JSON.stringify(next.user))
          setAuth(next.required, next.user, { hosted: next.hosted, viewedBy: next.viewedBy });
        writeSnap(d.user ? next : null);
        // the projects follow the account (App.tsx WorkspaceSync)
        if (!d.user) useWorkspace.getState().reset();
        setMustLink(d.mustLink ?? []);
        setState(
          d.required && !d.authed && !publicShare
            ? "login"
            : d.mustLink?.length && !publicShare
              ? "link"
              : "ok",
        );
      })
      .catch(() => setState("ok")); // server unreachable — let the app surface it
  }, [setAuth, pathname, publicShare]);

  useEffect(() => {
    if (state !== "login") return;
    // only a server that mounts the route answers ok; elsewhere the account gate's 401 must not read as providers
    fetch("/api/account/providers?login=1")
      .then((r) => (r.ok ? (r.json() as Promise<SignInProviders>) : Promise.reject(new Error(String(r.status)))))
      .then(setProviders)
      .catch(() => setProviders({ apple: false, google: false, github: false }));
  }, [state]);

  // a plug-in's product site on its own host (the hosted front page): shown signed in or not
  const site = siteFrameFor(window.location.hostname, pathname, window.location.search, webPlugins);
  if (site) return <>{site.element}</>;
  if (state === "checking") return <div className="h-screen bg-background" />;
  if (invite && hosted) return <JoinPage token={invite} />;
  if (state === "ok") return <>{children}</>;
  if (state === "link") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-zinc-950 px-4 text-center text-zinc-200">
        <p className="max-w-sm text-sm">
          Your team signs in with {mustLink.map((p) => (p === "apple" ? "Apple" : "Google")).join(" or ")}. Link yours once, and use it to sign in from now on.
        </p>
        {mustLink.map((p) => (
          <a key={p} href={`/api/account/login/${p}?for=link`} className="w-72 rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500">
            Link {p === "apple" ? "Apple" : "Google"}
          </a>
        ))}
      </div>
    );
  }
  if (publicShare) return <>{children}</>;

  const anyProvider = !!providers && (["apple", "google", "github"] as const).some((p) => providers[p]);
  const passwords = providers?.password !== false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) signedIn(d.user ?? null);
      else if (typeof d.step === "string") setStep({ token: d.step, setup: d.code === "CODE_SETUP" });
      else {
        setError(d.error || "Login failed");
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  function signedIn(user: Me | null) {
    const back = returnTo(window.location.search, window.location.origin);
    if (back) {
      window.location.replace(back);
      return;
    }
    setAuth(true, user);
    writeSnap(user ? { required: true, user, hosted: useAuth.getState().hosted, viewedBy: null } : null);
    setStep(null);
    setState("ok");
  }

  const expired = (message: string) => {
    setStep(null);
    setError(message);
  };
  if (step) return <CodeStep step={step.token} setup={step.setup} onDone={signedIn} onExpired={expired} />;

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-200">
      <div className="mb-6 flex items-center gap-3">
        <ToolsetLogo className="h-11 w-11" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Creator Toolset</h1>
          <p className="text-sm text-zinc-500">Sign in to your account</p>
        </div>
      </div>
      {error && <p className="w-72 text-xs text-red-400">{error}</p>}
      {providers && (
        <div className="flex w-72 flex-col gap-2">
          <ProviderButtons providers={providers} />
          {anyProvider && passwords && !usePassword && (
            <button type="button" onClick={() => setUsePassword(true)} className="py-1 text-xs text-zinc-500 hover:text-zinc-300">
              Use a password instead
            </button>
          )}
        </div>
      )}
      {providers && passwords && (!anyProvider || usePassword) && (
      <form onSubmit={submit} className="flex w-72 flex-col gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 focus-within:border-violet-500">
          <UserRound className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            autoFocus
            autoCapitalize="none"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
          />
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 focus-within:border-violet-500">
          <Lock className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
      )}
    </div>
  );
}
