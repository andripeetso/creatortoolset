import { useState } from "react";
import { Link } from "react-router";
import { Captions, Lock, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";

/**
 * Mobile exports render on the server (MobileExport), which guests can't
 * use — so mobile is account-only; this screen says so and offers login.
 */
export function MobileGuestGate() {
  const setAuth = useAuth((s) => s.setAuth);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        setAuth(true, d.user ?? null);
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
    <div className="pt-safe pb-safe flex h-dvh flex-col items-center justify-center bg-[#0b0b10] px-8 text-zinc-200">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600">
        <Captions className="h-7 w-7 text-white" />
      </div>
      <h1 className="text-center text-xl font-semibold tracking-tight">
        Sign in for mobile captions
      </h1>
      <p className="mt-2 max-w-xs text-center text-sm leading-6 text-zinc-400">
        On a phone the finished video renders on our server, which needs an
        account. Guest mode works on a computer.
      </p>

      <form onSubmit={submit} className="mt-6 flex w-full max-w-xs flex-col gap-2.5">
        <div className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-3 focus-within:border-violet-500">
          <UserRound className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            autoCapitalize="none"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="w-full bg-transparent text-base outline-none placeholder:text-zinc-600"
          />
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-3 focus-within:border-violet-500">
          <Lock className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-transparent text-base outline-none placeholder:text-zinc-600"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="mt-1 rounded-xl bg-violet-600 py-3 text-base font-semibold text-white active:bg-violet-500 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
      <Link
        to="/m"
        className="mt-5 text-sm text-zinc-500 active:text-zinc-300"
      >
        All tools
      </Link>
    </div>
  );
}
