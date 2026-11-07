import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Blocks, Lock, UserRound } from "lucide-react";
import { returnTo, useAuth, type Me } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { JoinPage } from "@/pages/JoinPage";
import { joinToken } from "@/lib/workspaces";

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

export function isPublicSharePath(pathname: string): boolean {
  return isPublicClipPath(pathname) || isPublicDocumentPath(pathname) || /^\/(privacy|terms|data-deletion)\/?$/.test(pathname);
}

/** Review share links: /r/<token>, and a project's /rp/<token>[/<video>];
 *  Content Workshop share links, /ws/<token>
 *  (a freelancer opens it with no account). Kept out of isPublicSharePath so
 *  the light/dark share theme never touches these (always dark) screens. */
export function isPublicReviewPath(pathname: string): boolean {
  return new RegExp(`^/(?:r/${PUBLIC_UUID}|rp/${PUBLIC_UUID}(?:/${PUBLIC_UUID})?|fs/${PUBLIC_UUID}|ws/${PUBLIC_UUID})/?$`, "i").test(pathname);
}

/**
 * Blocks the app behind an account login when the server has
 * APP_SECRET set (public hosting). Renders children immediately when
 * auth is not required (local use). Public clip share URLs skip the
 * login screen so a pasted clip or published document just opens.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const publicShare = isPublicSharePath(pathname) || isPublicReviewPath(pathname) || isPublicLibraryPath(pathname);
  const [state, setState] = useState<"checking" | "login" | "ok">("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setAuth = useAuth((s) => s.setAuth);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((d: { required: boolean; authed: boolean; user: Me | null; demo?: boolean }) => {
        // Signed in with an account and sent here to sign in (?next=): go back.
        const back = returnTo(window.location.search, window.location.origin);
        const account = d.authed && d.user?.role !== "guest";
        if (back && account) {
          window.location.replace(back);
          return;
        }
        setAuth(d.required, d.user);
        if (d.user) void useWorkspace.getState().load();
        else useWorkspace.getState().reset();
        setState(
          d.required && (!d.authed || (back && !account)) && !publicShare
            ? "login"
            : "ok",
        );
      })
      .catch(() => setState("ok")); // server unreachable — let the app surface it
  }, [setAuth, pathname, publicShare]);

  // an invite link (Settings → Team) opens the same signed in or not
  const invite = joinToken(pathname);
  if (invite) return <JoinPage token={invite} />;

  if (state === "ok") return <>{children}</>;
  if (state === "checking") return <div className="h-screen bg-background" />;
  if (publicShare) return <>{children}</>;

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
      if (res.ok) {
        const back = returnTo(window.location.search, window.location.origin);
        if (back) {
          window.location.replace(back);
          return;
        }
        setAuth(true, d.user ?? null);
        void useWorkspace.getState().load();
        setState("ok");
      } else {
        setError(d.error || "Login failed");
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#0b0b10] text-zinc-200">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600">
          <Blocks className="h-6 w-6 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Creator Toolset</h1>
          <p className="text-sm text-zinc-500">Sign in to your account</p>
        </div>
      </div>
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
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
