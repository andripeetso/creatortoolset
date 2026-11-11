import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, ListRow, Row, Section, Status } from "@/components/settings/ui";

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

/**
 * Setup's last screen, which anyone can skip: one row for each sign-in the Mac app names, each with its one button
 * (Sign in, Signing in… while the system's sheet is up). Signed in, the rows give way to who it is. A sheet that was
 * closed is nothing to report; a sign-in that failed says so in one line and the buttons stay. Pure, for tests.
 */
export function AccountSetupView({ account, providers, busy, onSignIn }: Pick<MacAccount, "account" | "providers" | "busy"> & { onSignIn: (p: Provider) => void }) {
  if (account.state === "signedIn")
    return (
      <Card>
        <ListRow title={`Signed in as ${account.name || account.email || "you"}`} subtitle={account.name && account.email ? account.email : undefined} actions={<Check aria-label="Signed in" className="size-4 text-emerald-600 dark:text-emerald-400" />} />
      </Card>
    );
  // opened with nothing to offer (an old link to this screen): said in one line, and Done closes it
  if (providers.length === 0) return <p className="text-sm text-muted-foreground">Sign-in is not available right now.</p>;
  const failed =
    account.state === "error" ? account.message || "The sign-in didn't work. Try again."
    : account.state === "notSetUp" ? "Sign-in is not available right now."
    : account.state === "unreachable" ? "Couldn't reach the account server. Check the internet connection, then try again."
    : null;
  return (
    <div className="space-y-2">
      <Card>
        {providers.map((p) => (
          <ListRow
            key={p}
            title={PROVIDER_NAME[p]}
            actions={
              <Button size="xs" variant="outline" disabled={!!busy} onClick={() => onSignIn(p)}>
                {busy === p ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <LogIn aria-hidden className="size-3" />}
                {busy === p ? "Signing in…" : "Sign in"}
              </Button>
            }
          />
        ))}
      </Card>
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
