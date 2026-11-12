import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/settings/ui";
import { PROVIDER_NAME, ProviderMark, type Provider } from "@/components/ProviderMark";
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
  | { state: "signedIn"; name?: string; email?: string; /** the sign-in it was made with, when the Mac app remembers it */ provider?: string }
  | { state: "notSetUp"; server?: string }
  | { state: "unreachable"; server?: string; message?: string }
  | { state: "error"; message?: string };

export type { Provider };
const PROVIDERS: Provider[] = ["apple", "google", "github"];
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
          <p className="text-foreground">Sign in to set up your Creator Toolset account.</p>
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

/** The sign-in card's one button per provider: the app's own plain button, with the provider's mark. */
/** One sign-in's button: the provider's mark and Continue with …, the same on setup's card and in Settings → Account. */
export const SIGN_IN_BUTTON =
  "flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-background text-sm font-medium text-foreground transition-colors hover:bg-accent " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default";

/**
 * Setup's last screen, which anyone can skip: a sign-in card in the middle of the window. Its title and one line at the
 * left, then one button for each sign-in the Mac app names, as wide as the card, with the provider's mark and
 * "Continue with …" (the system's sign-in sheet opens; the button it came from says Signing in… meanwhile). Signing in
 * finishes setup (SetupDialog), so "You're signed in" with who it is shows only for the moment that takes, or when the
 * screen is opened by someone already signed in. A sheet that was closed is nothing to report; a sign-in that failed
 * says so in one line and the buttons stay. The line says what the account is and never what is or is not read from
 * the Apple or Google account (the owner, 2026-11-11: such a promise was untrue). Pure, for tests.
 */
export function AccountSetupView({ account, providers, busy, onSignIn }: Pick<MacAccount, "account" | "providers" | "busy"> & { onSignIn: (p: Provider) => void }) {
  const signedIn = account.state === "signedIn";
  const who = signedIn ? account.name || account.email || "" : "";
  const failed =
    account.state === "error" ? account.message || "The sign-in didn't work. Try again."
    : account.state === "notSetUp" ? "Sign-in is not available right now."
    : account.state === "unreachable" ? "Couldn't reach the account server. Check the internet connection, then try again."
    : null;
  return (
    <div className="flex h-full items-center justify-center">
      <section aria-label="Sign in" className="w-full max-w-[400px] overflow-hidden rounded-2xl border border-border bg-card shadow-lg shadow-black/10">
        <div className="space-y-6 p-8">
          <div className="space-y-1">
            <h3 className="text-xl font-semibold tracking-tight text-foreground">{signedIn ? "You're signed in" : "Sign in to Creator Toolset"}</h3>
            {!signedIn && <p className="text-sm text-muted-foreground">Optional. One account for this app and creatortoolset.com.</p>}
          </div>
          {signedIn ? (
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tint)_22%,transparent)] text-base font-semibold text-foreground" aria-hidden>
                {who.charAt(0).toUpperCase() || "·"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">Signed in as {who || "you"}</p>
                {account.name && account.email && <p className="truncate text-xs text-muted-foreground">{account.email}</p>}
              </div>
              <Check aria-label="Signed in" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            </div>
          ) : providers.length === 0 ? (
            // opened with nothing to offer (an old link to this screen): said in one line, and Done closes it
            <p className="text-sm text-muted-foreground">Sign-in is not available right now.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {providers.map((p) => (
                <button key={p} type="button" disabled={!!busy} onClick={() => onSignIn(p)} className={cn(SIGN_IN_BUTTON, busy && busy !== p && "opacity-50")}>
                  {busy === p ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ProviderMark provider={p} className="size-4 shrink-0" />}
                  <span>{busy === p ? "Signing in…" : `Continue with ${PROVIDER_NAME[p]}`}</span>
                </button>
              ))}
              {failed && !busy && (
                <div className="pt-1">
                  <Status tone="broken">{failed}</Status>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
