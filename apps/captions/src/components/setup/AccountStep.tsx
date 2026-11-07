import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The person's Creator Toolset account, signed in with Apple or Google: optional, in setup's What's left and Settings → Setup. The Mac app does the sign-in
 * (its `account` message handler, Account.swift) and answers each message with the state below. Required: Continue
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

type Bridge = { postMessage: (m: string) => Promise<AccountState> };
const bridge = (): Bridge | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { account?: Bridge } } }).webkit?.messageHandlers?.account;

/** The Mac app's sign-in is here: only then does setup show this step. */
export const hasAccountBridge = () => !!bridge();

/** Whether the person may go on from this step. */
export const accountDone = (s: AccountState) => s.state === "signedIn" || s.state === "notSetUp" || s.state === "unreachable" || s.state === "off";

export function AccountStepView({ account, busy, onSignIn, onDone }: { account: AccountState; busy: boolean; onSignIn: (provider: "apple" | "google") => void; onDone?: () => void }) {
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
          <p className="text-foreground">Sign in to set up your account. Your Apple or Google account gives your name and email, nothing else.</p>
          {account.state === "cancelled" && <p>The sign-in was closed before it finished.</p>}
          {account.state === "error" && <p className="text-destructive">{account.message || "The sign-in didn't work."}</p>}
          <div className="flex flex-col gap-2 sm:w-72">
            <Button disabled={busy} onClick={() => onSignIn("apple")}>
              Continue with Apple
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => onSignIn("google")}>
              Continue with Google
            </Button>
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

/** Without `onDone` (What's left, Settings → Setup) it is an optional row: no Continue button. */
export function AccountStep({ onDone }: { onDone?: () => void }) {
  const [account, setAccount] = useState<AccountState>({ state: "checking" });
  const [busy, setBusy] = useState(false);
  const ask = useCallback(async (m: string) => {
    const b = bridge();
    if (!b) return setAccount({ state: "off" });
    try {
      setAccount(await b.postMessage(m));
    } catch (e) {
      setAccount({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => {
    void ask("status");
    // a sign-in finished through a creatortoolset:// link rather than the sheet: the app says so
    const again = () => void ask("status");
    window.addEventListener("ct-account", again);
    return () => window.removeEventListener("ct-account", again);
  }, [ask]);
  const signIn = (provider: "apple" | "google") => {
    setBusy(true);
    void ask(provider).finally(() => setBusy(false));
  };
  return <AccountStepView account={account} busy={busy} onSignIn={signIn} onDone={onDone} />;
}
