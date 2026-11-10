import { useEffect, useState } from "react";
import { Lock, UserRound } from "lucide-react";
import { ToolsetLogo } from "@/components/HomeLink";
import type { InviteInfo } from "@contracts/workspaces";
import { inviteInfo, joinWithInvite } from "@/lib/workspaces";

/**
 * /join/<token>: an invite to a team (Settings → Team; hosted servers only). Signed in: join with that account. Else
 * make an account with your own username and password (signed in at once), or sign in first and come back to the link.
 */
export function JoinPage({ token }: { token: string }) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inviteInfo(token).then(setInfo).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const join = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await joinWithInvite(token, info?.signedInAs ? undefined : { username, password });
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const field = "flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 focus-within:border-violet-500";
  const input = "w-full bg-transparent text-sm outline-none placeholder:text-zinc-600";
  const button = "rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50";

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-200">
      {/* Nothing here moves once it shows: the name appears with the invite's answer (its width is the team's name), the
          line under it keeps its place, and the block below is as tall as the form it most often becomes. */}
      <div className={`mb-6 flex items-center gap-3 ${info || error ? "" : "invisible"}`}>
        <ToolsetLogo className="h-11 w-11" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{info ? `Join ${info.workspace}` : "Creator Toolset"}</h1>
          <p className="min-h-5 text-sm text-zinc-500">{info && `${info.invitedBy} invited you to join`}</p>
        </div>
      </div>
      <div className="flex min-h-[192px] w-72 flex-col gap-2">
        {!info && !error && <p className="text-sm text-zinc-500">Checking the invite…</p>}
        {info?.expired && <p className="text-sm text-zinc-400">This invite link has expired. Ask {info.invitedBy} for a new one.</p>}
        {info && !info.expired && info.member && (
          <a href="/" className={`${button} text-center`}>
            You're already in it: open Creator Toolset
          </a>
        )}
        {info && !info.expired && !info.member && info.signedInAs && (
          <>
            <button className={button} disabled={busy} onClick={() => void join()}>
              Join as {info.signedInAs}
            </button>
            <p className="text-xs text-zinc-500">Not you? Sign out first, then open the link again.</p>
          </>
        )}
        {info && !info.expired && !info.member && !info.signedInAs && (
          <form onSubmit={join} className="flex flex-col gap-2">
            <p className="text-xs text-zinc-500">Make your account: pick a username and a password (6 characters or more).</p>
            <div className={field}>
              <UserRound className="h-4 w-4 shrink-0 text-zinc-500" />
              <input autoFocus autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" className={input} />
            </div>
            <div className={field}>
              <Lock className="h-4 w-4 shrink-0 text-zinc-500" />
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className={input} />
            </div>
            <button type="submit" className={button} disabled={busy || !username || password.length < 6}>
              {busy ? "Joining…" : "Create account and join"}
            </button>
            <a href={`/?next=${encodeURIComponent(`/join/${token}`)}`} className="text-center text-xs text-zinc-500 hover:text-zinc-300">
              I already have an account: sign in first
            </a>
          </form>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
