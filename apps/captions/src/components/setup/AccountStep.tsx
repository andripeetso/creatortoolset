import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Row, Section, Status } from "@/components/settings/ui";
import { cn } from "@/lib/utils";

/**
 * The person's Creator Toolset account, signed in with Apple, Google or GitHub: optional, in setup's What's left and Settings → Setup. The Mac app does the sign-in
 * (its `account` message handler, Account.swift) and answers each message with the state below. The signed-out reply
 * names the providers the account server has keys for (`providers`, "apple,google,github"): a provider without keys has no button. Required: Continue
 * shows only once signed in, or while the account server says sign-in isn't set up yet or can't be reached (offline:
 * it asks again next time), or with no account step at all (no Mac app, or Mac settings left the account server empty). Each mount asks again, so the step becomes
 * required by itself once the server has sign-in.
 */

export type AccountState =
  | { state: "checking" | "signedOut" | "cancelled" | "off" }
  | { state: "signedIn"; name?: string; email?: string }
  | { state: "notSetUp"; server?: string }
  | { state: "unreachable"; server?: string; message?: string }
  | { state: "error"; message?: string };

export type Provider = "apple" | "google" | "github";
const PROVIDERS: Provider[] = ["apple", "google", "github"];
const PROVIDER_NAME: Record<Provider, string> = { apple: "Apple", google: "Google", github: "GitHub" };
/** The providers a reply names, in the order it names them (the Mac app decides which comes first); unknown names and repeats are dropped. */
export const parseProviders = (list: string) => [...new Set(list.split(","))].filter((p): p is Provider => (PROVIDERS as string[]).includes(p));

type Bridge = { postMessage: (m: string) => Promise<AccountState & { providers?: string }> };
const bridge = (): Bridge | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { account?: Bridge } } }).webkit?.messageHandlers?.account;

/** The Mac app's sign-in is here: only then does setup show this step. */
export const hasAccountBridge = () => !!bridge();

/** Whether the person may go on from this step. */
export const accountDone = (s: AccountState) => s.state === "signedIn" || s.state === "notSetUp" || s.state === "unreachable" || s.state === "off";

export function AccountStepView({ account, busy, providers = [], onSignIn, onDone }: { account: AccountState; busy: boolean; providers?: Provider[]; onSignIn: (provider: Provider) => void; onDone?: () => void }) {
  return (
    <div className="max-w-xl space-y-4 text-sm text-muted-foreground">
      {account.state === "checking" && <p>Checking your account…</p>}
      {account.state === "signedIn" && (
        <p className="text-foreground">
          Signed in as {account.name || account.email}
          {account.name && account.email ? ` (${account.email})` : ""}.
        </p>
      )}
      {account.state === "notSetUp" && (
        <p>Sign-in isn't set up on {account.server || "the account server"} yet, so you can go on without an account. This step will ask again once it is.</p>
      )}
      {account.state === "unreachable" && (
        <p>Can't reach {account.server || "the account server"} right now, so you can go on without an account. This step will ask again next time.</p>
      )}
      {account.state === "off" && <p>No account is needed here.</p>}
      {(account.state === "signedOut" || account.state === "cancelled" || account.state === "error") && (
        <>
          <p className="text-foreground">Sign in to set up your account. Your Apple, Google or GitHub account gives your name and email, nothing else.</p>
          {account.state === "cancelled" && <p>The sign-in was closed before it finished.</p>}
          {account.state === "error" && <p className="text-destructive">{account.message || "The sign-in didn't work."}</p>}
          <div className="flex flex-col gap-2 sm:w-72">
            {providers.map((p, i) => (
              <Button key={p} variant={i === 0 ? "default" : "outline"} disabled={busy} onClick={() => onSignIn(p)}>
                Continue with {PROVIDER_NAME[p]}
              </Button>
            ))}
          </div>
        </>
      )}
      {onDone && accountDone(account) && (
        <Button size="sm" onClick={onDone}>
          Continue
        </Button>
      )}
    </div>
  );
}

/**
 * The Mac app's account, as this page knows it. It is asked once when the screen opens and again after a sign-in that
 * ended in a link; everything else follows a press here. Signed out, the Mac app answers from its own list and asks the
 * account server nothing (Account.swift accountLive), so nothing leaves this computer before a press. `providers` keeps
 * the last list the app named: an answer without one (signed in, cancelled) leaves the buttons where they were.
 * `first`: the opening question. Setup's screen and Settings ask "offered", which a Mac app from before 2026-11-10 answers
 * "off" (so it shows nothing there); "status" is the older question, which such an app answers by asking its server.
 * `on`: ask only while this is true (the setup window is up).
 */
export function useMacAccount({ on = true, first = "status" }: { on?: boolean; first?: "status" | "offered" } = {}) {
  const [account, setAccount] = useState<AccountState>(() => (bridge() ? { state: "checking" } : { state: "off" }));
  const [providers, setProviders] = useState<Provider[]>([]);
  const [busy, setBusy] = useState<Provider | "signout" | null>(null);
  const ask = useCallback(async (m: string) => {
    const b = bridge();
    if (!b) return setAccount({ state: "off" });
    try {
      const reply = await b.postMessage(m);
      // a provider is offered only when the app names it; no list at all (an older Mac app) never adds a button
      if (reply.providers !== undefined) setProviders(parseProviders(reply.providers));
      setAccount(reply);
    } catch (e) {
      setAccount({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => {
    if (!on) return;
    void ask(first);
    // a sign-in finished through a creatortoolset:// link rather than the sheet: the app says so
    const again = () => void ask(first);
    window.addEventListener("ct-account", again);
    return () => window.removeEventListener("ct-account", again);
  }, [ask, on, first]);
  const signIn = (provider: Provider) => {
    setBusy(provider);
    void ask(provider).finally(() => setBusy(null));
  };
  const signOut = () => {
    setBusy("signout");
    void ask("signout").finally(() => setBusy(null));
  };
  return { account, providers, busy, signIn, signOut };
}
export type MacAccount = ReturnType<typeof useMacAccount>;

/** Without `onDone` (What's left, Settings → Setup) it is an optional row: no Continue button. */
export function AccountStep({ onDone }: { onDone?: () => void }) {
  const { account, providers, busy, signIn } = useMacAccount();
  return <AccountStepView account={account} busy={!!busy} providers={providers} onSignIn={signIn} onDone={onDone} />;
}

/** Whether setup has an account screen: the Mac app names a sign-in and the person is not signed in yet. */
export const offersAccount = (a: Pick<MacAccount, "account" | "providers">) =>
  a.providers.length > 0 && a.account.state !== "signedIn" && a.account.state !== "off" && a.account.state !== "checking";

/** Each provider's own mark, as its sign-in button carries it (Google's in its four colours, the others in the button's text colour). */
export function ProviderMark({ provider, className }: { provider: Provider; className?: string }) {
  if (provider === "google")
    return (
      <svg viewBox="0 0 48 48" aria-hidden className={className}>
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  if (provider === "apple")
    return (
      <svg viewBox="0 0 24 24" aria-hidden fill="currentColor" className={className}>
        <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="currentColor" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/**
 * How each provider's sign-in button looks, after their own rules: Google's is white with its mark in colour; Apple's is
 * black on a light page and white on a dark one; GitHub's follows Apple's.
 */
const SIGN_IN_LOOK: Record<Provider, string> = {
  google: "border-[#747775] bg-white text-[#1f1f1f] hover:bg-[#f2f2f2]",
  apple: "border-black bg-black text-white hover:bg-zinc-800 dark:border-white dark:bg-white dark:text-black dark:hover:bg-zinc-200",
  github: "border-[#24292f] bg-[#24292f] text-white hover:bg-[#32383f] dark:border-white dark:bg-white dark:text-[#24292f] dark:hover:bg-zinc-200",
};

/**
 * Setup's last screen, which anyone can skip: a sign-in screen. One button for each sign-in the Mac app names, as wide
 * as each other, with the provider's mark and "Continue with …" (the system's sign-in sheet opens; the button it came
 * from says Signing in… meanwhile). Signed in, the buttons give way to who it is. A sheet that was closed is nothing to
 * report; a sign-in that failed says so in one line and the buttons stay. Pure, for tests.
 */
export function AccountSetupView({ account, providers, busy, onSignIn }: Pick<MacAccount, "account" | "providers" | "busy"> & { onSignIn: (p: Provider) => void }) {
  if (account.state === "signedIn") {
    const who = account.name || account.email || "";
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tint)_22%,transparent)] text-xl font-semibold text-foreground" aria-hidden>
          {who.charAt(0).toUpperCase() || <Check className="size-6" />}
        </span>
        <div>
          <p className="flex items-center justify-center gap-1.5 text-base font-medium text-foreground">
            Signed in as {who || "you"}
            <Check aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" />
          </p>
          {account.name && account.email && <p className="text-sm text-muted-foreground">{account.email}</p>}
        </div>
      </div>
    );
  }
  // opened with nothing to offer (an old link to this screen): said in one line, and Done closes it
  if (providers.length === 0) return <p className="text-sm text-muted-foreground">Sign-in is not available right now.</p>;
  const failed =
    account.state === "error" ? account.message || "The sign-in didn't work. Try again."
    : account.state === "notSetUp" ? "Sign-in is not available right now."
    : account.state === "unreachable" ? "Couldn't reach the account server. Check the internet connection, then try again."
    : null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="flex w-full max-w-[320px] flex-col gap-2.5">
        {providers.map((p) => (
          <button
            key={p}
            type="button"
            disabled={!!busy}
            onClick={() => onSignIn(p)}
            className={cn(
              "flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "disabled:cursor-default",
              busy && busy !== p && "opacity-50",
              SIGN_IN_LOOK[p],
            )}
          >
            {busy === p ? <Loader2 aria-hidden className="size-[18px] animate-spin" /> : <ProviderMark provider={p} className="size-[18px] shrink-0" />}
            <span>{busy === p ? "Signing in…" : `Continue with ${PROVIDER_NAME[p]}`}</span>
          </button>
        ))}
      </div>
      {failed && !busy && <Status tone="broken">{failed}</Status>}
    </div>
  );
}

/**
 * Settings → Account, in the Mac app only: the Creator Toolset account this Mac is signed in to, with Sign out. Nothing
 * at all when there is no Mac app, or nobody is signed in: the section is the connection and its one action, never a
 * prompt to sign in.
 */
export function MacAccountSection() {
  const { account, busy, signOut } = useMacAccount({ first: "offered" });
  if (account.state !== "signedIn") return null;
  return (
    <Section title="Creator Toolset account">
      <Card>
        <Row
          title={account.name || account.email || "Signed in"}
          description={account.name && account.email ? account.email : undefined}
          control={
            <Button size="sm" variant="outline" disabled={busy === "signout"} onClick={signOut}>
              {busy === "signout" ? "Signing out…" : "Sign out"}
            </Button>
          }
        />
      </Card>
    </Section>
  );
}
