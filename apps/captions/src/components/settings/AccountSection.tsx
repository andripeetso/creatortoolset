import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { logout, useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserRound } from "lucide-react";
import { PROVIDER_NAME, ProviderMark, type Provider } from "@/components/ProviderMark";
import { hasAccountBridge, linkedOf, useMacAccount } from "@/components/setup/AccountStep";
import { SignInCodeRow } from "@/components/SignInCode";
import { Card, EmptyRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, type RowMenuItem } from "./ui";

const PROVIDERS: Provider[] = ["google", "apple", "github"];

/** GET /api/auth/account: the names the app shows, the sign-ins linked here (with their address and picture URL). */
interface SignIn {
  provider: Provider;
  email: string;
  name: string;
  picture: string | null;
}
interface AccountView {
  username: string;
  name: string;
  login: string;
  identities: Provider[];
  signins: SignIn[];
  picture: string | null;
}

const failure = (r: Response, d: { error?: string }) => new Error(d.error ?? `Could not save it (${r.status})`);
const JSON_HEADERS = { "Content-Type": "application/json" };

/** The allowed sign-in name (users.ts setLogin): shown only when the typed value breaks it. */
export const SIGNIN_NAME_RULE = "2–24 characters: lowercase letters, digits, - and _";
export function signInNameProblem(typed: string): string | null {
  const n = typed.trim().toLowerCase();
  return n === "" || /^[a-z0-9][a-z0-9_-]{1,23}$/.test(n) ? null : SIGNIN_NAME_RULE;
}

/**
 * The toast for a sign-in return (api/sign-in.ts redirects to /settings/account?linked=<provider> or ?signin=<message>).
 * null when the page was not opened by one of those.
 */
export function signInReturn(search: string): { tone: "success" | "error"; text: string } | null {
  const params = new URLSearchParams(search);
  const linked = params.get("linked");
  const signin = params.get("signin");
  if (signin) return { tone: "error", text: signin };
  if (linked && linked in PROVIDER_NAME) return { tone: "success", text: `${PROVIDER_NAME[linked as Provider]} sign-in added` };
  return null;
}

/**
 * The account's picture when it has one (from a linked Google or GitHub sign-in), else the initial. The picture loads
 * from its own URL; if it fails, the initial shows instead. UserMenu passes its own fallback (an icon).
 */
export function AccountAvatar({ picture, initial, className, fallback }: { picture?: string | null; initial: string; className?: string; fallback?: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (picture && failed !== picture) {
    return <img src={picture} alt="" referrerPolicy="no-referrer" onError={() => setFailed(picture)} className={cn("shrink-0 rounded-full object-cover", className)} />;
  }
  if (fallback) return <>{fallback}</>;
  return <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-muted font-medium uppercase text-muted-foreground", className)}>{initial}</span>;
}

const NO_SIGN_INS = Object.fromEntries(PROVIDERS.map((p) => [p, false])) as Record<Provider, boolean>;
/**
 * The sign-ins this server has switched on (Account links them, Team picks from them): the saved copy at once. A server
 * that does not answer has none.
 */
export function useSignInApps(): Record<Provider, boolean> | null {
  const { data, error } = useCachedLoad<Record<Provider, boolean>>("/api/account/providers", () =>
    fetch("/api/account/providers").then((r) => (r.ok ? (r.json() as Promise<Record<Provider, boolean>>) : NO_SIGN_INS)),
  );
  return data ?? (error ? NO_SIGN_INS : null);
}

/** Settings → Account: the name, sign-in name and password; the sign-ins (Google, Apple, GitHub); sign out of this server. */
export function AccountSection() {
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  // a computer with no account answers 401 here ("none"): the page then says so, instead of a name that can never save
  const stored = useCachedLoad<AccountView | "none">("/api/auth/account", () =>
    fetch("/api/auth/account").then((r) => (r.status === 401 ? "none" : r.ok ? (r.json() as Promise<AccountView>) : Promise.reject(new Error(`Request failed (${r.status})`)))),
  );
  const noAccount = stored.data === "none";
  const account = stored.data === "none" ? null : stored.data;
  const setStored = stored.set;
  const setAccount = (change: (a: AccountView) => AccountView) => setStored((a) => (a && a !== "none" ? change(a) : a));
  const refresh = stored.refresh;
  const load = () => refresh().catch(() => {});
  const providers = useSignInApps();
  const [params, setParams] = useSearchParams();
  const told = useRef(false);

  // The sign-in return: api/sign-in.ts sends the browser back with ?linked=<provider> or ?signin=<message>
  useEffect(() => {
    if (told.current) return;
    const note = signInReturn(params.toString());
    if (!note) return;
    told.current = true;
    if (note.tone === "success") toast.success(note.text);
    else toast.error(note.text);
    setParams({}, { replace: true });
    void load();
    // load and setParams are stable for this one-time read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // a link finished in the system browser (the Mac app opens sign-ins there): coming back to the window shows it
  useEffect(() => {
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
    // load is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <LoadingRow />;
  if (noAccount) {
    return (
      <Section title="Profile">
        <Card>
          <EmptyRow title="No account on this computer" />
        </Card>
      </Section>
    );
  }
  // everything the page shows is loaded before it is drawn, so nothing moves in after
  if (!account || !providers) return <LoadingRow />;

  const linkable = PROVIDERS.filter((p) => providers[p]);
  const saved = (name: string) => {
    setAccount((a) => ({ ...a, name }));
    useAuth.getState().setAuth(required, { ...me, name: name || me.username });
  };

  return (
    <>
      <Section title="Profile">
        <Card>
          <NameRow name={account.name} username={account.username} onSaved={saved} />
          {required && <SignInNameRow login={account.login} onSaved={(login) => setAccount((a) => ({ ...a, login }))} />}
          {required && <PasswordRow />}
          {required && <SignInCodeRow />}
        </Card>
      </Section>

      <SignIns
        signins={account.signins.filter((x) => linkable.includes(x.provider))}
        open={linkable.filter((p) => !account.signins.some((x) => x.provider === p))}
        unlink={async (p) => {
          const r = await fetch(`/api/auth/identity/${p}`, { method: "DELETE" });
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          if (!r.ok) throw failure(r, d);
          await load();
        }}
      />
      {hasAccountBridge() && <MacAppAccount />}
      {required && (
        <Section title="Session">
          <Card>
            <Row id="sign-out" title="This server" control={<Button size="sm" variant="outline" onClick={() => void logout()}>Sign out</Button>} />
          </Card>
        </Section>
      )}
    </>
  );
}

const isProvider = (p: string | undefined): p is Provider => !!p && (PROVIDERS as string[]).includes(p);

/**
 * Sign-ins: how this account signs in to this server. Each one it has, with the provider's mark, who it is there and
 * Disconnect, then a row with Add for each one still open. The server lists a provider only where it runs sign-ins (GET
 * /api/account/providers: none off a hosted server), and only a listed provider's sign-in has a row, so Disconnect is
 * never offered where the server's route refuses it (api/auth.ts DELETE /identity/:provider). Nothing there and nothing
 * to add means no section at all. The Mac app's own account is never listed here: it is not a sign-in to this server
 * (MacAppAccount below).
 */
function SignIns({ signins, open, unlink }: { signins: SignIn[]; open: Provider[]; unlink: (p: Provider) => Promise<void> }) {
  if (!signins.length && !open.length) return null;
  const mark = (p: Provider) => (
    <span className="text-foreground">
      <ProviderMark provider={p} className="size-4" />
    </span>
  );
  return (
    <Section id="sign-in-with" title="Sign-ins">
      <Card>
        {signins.map((s) => (
          <ListRow
            key={s.provider}
            icon={mark(s.provider)}
            title={PROVIDER_NAME[s.provider]}
            subtitle={[s.name, s.email].filter(Boolean).join(" · ") || undefined}
            actions={
              <RowMenu
                label={`${PROVIDER_NAME[s.provider]} actions`}
                items={[{ label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${PROVIDER_NAME[s.provider]}?`, ok: "Disconnect" }, onSelect: () => unlink(s.provider) }]}
              />
            }
          />
        ))}
        {open.map((p) => (
          <ListRow
            key={`link-${p}`}
            icon={mark(p)}
            title={PROVIDER_NAME[p]}
            actions={
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/account/login/${p}?for=link`} aria-label={`Add ${PROVIDER_NAME[p]}`}>Add</a>
              </Button>
            }
          />
        ))}
      </Card>
    </Section>
  );
}

/** What the Mac app's account row's menu offers: one more sign-in for the account, dropping one it has, and signing the app out. */
export function macAccountItems(o: { linked: Provider[]; open: Provider[]; link: (p: Provider) => void; unlink: (p: Provider) => void; signOut: () => void }): RowMenuItem[] {
  return [
    ...o.open.map((p) => ({ label: `Add ${PROVIDER_NAME[p]}`, onSelect: async () => o.link(p) })),
    { label: "Sign out", onSelect: async () => o.signOut() },
    ...o.linked.map((p) => ({ label: `Disconnect ${PROVIDER_NAME[p]}`, destructive: true, confirm: { title: `Disconnect ${PROVIDER_NAME[p]}?`, ok: "Disconnect" }, onSelect: async () => o.unlink(p) })),
  ];
}

/**
 * Creator Toolset account, in the Mac app only: the account the app itself is signed in to, which is the app's and not a
 * sign-in to the server in the window. One row whatever its state, so a provider this server also signs in with is
 * never listed twice: signed out, a button for each sign-in the app offers; signed in, who it is and the ways in, with
 * the rest (one more sign-in, Disconnect, Sign out) in its menu. Nothing to show (no account server, none offered) means
 * no section.
 */
function MacAppAccount() {
  const mac = useMacAccount({ first: "offered" });
  const macIn = mac.account.state === "signedIn" ? mac.account : null;
  const linked = linkedOf(mac.account).map((l) => l.provider);
  // a sign-in from here that failed says so once (the sheet being closed is nothing to report)
  const failed =
    mac.problem ??
    (mac.account.state === "error" ? mac.account.message || "Could not sign in. Try again." : mac.account.state === "unreachable" ? "Could not reach the account server. Try again." : null);
  useEffect(() => {
    if (failed) toast.error(failed);
  }, [failed]);
  if (!macIn && !mac.providers.length) return null;
  const first = macIn && isProvider(macIn.provider) ? macIn.provider : undefined;
  const ways = [...new Set([first, ...linked].filter((p): p is Provider => !!p))];
  return (
    <Section id="mac-account" title="Creator Toolset account">
      <Card>
        <ListRow
          icon={<span className="text-foreground">{first ? <ProviderMark provider={first} className="size-4" /> : <UserRound className="size-4" />}</span>}
          title="Mac app"
          subtitle={macIn ? [macIn.name, macIn.email].filter(Boolean).join(" · ") || undefined : undefined}
          status={macIn && ways.length > 1 ? ways.map((p) => PROVIDER_NAME[p]).join(" · ") : undefined}
          actions={
            macIn ? (
              <RowMenu
                label="Creator Toolset account actions"
                items={macAccountItems({ linked, open: mac.providers.filter((p) => !ways.includes(p)), link: mac.link, unlink: mac.unlink, signOut: mac.signOut })}
              />
            ) : (
              <span className="flex items-center gap-1.5">
                {mac.providers.map((p) => (
                  <Button key={p} size="sm" variant="outline" disabled={!!mac.busy} aria-label={`Sign in with ${PROVIDER_NAME[p]}`} onClick={() => mac.signIn(p)}>
                    <ProviderMark provider={p} className="size-3.5" />
                    {mac.busy === p ? "Signing in…" : PROVIDER_NAME[p]}
                  </Button>
                ))}
              </span>
            )
          }
        />
      </Card>
    </Section>
  );
}

/** The current value as text, with [Change] beside it; the change happens in a dialog. */
function Value({ text, label, onChange }: { text: string; label: string; onChange: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="min-w-0 truncate text-sm text-muted-foreground">{text}</span>
      <Button size="sm" variant="outline" aria-label={label} onClick={onChange}>
        Change
      </Button>
    </div>
  );
}

/** The name the app calls the person. One field, saved by its dialog. */
function NameRow({ name, username, onSaved }: { name: string; username: string; onSaved: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/account", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name: value }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw failure(r, d);
      onSaved(value.trim());
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        id="name"
        title="Name"
        control={
          <Value
            text={name || username}
            label="Change name"
            onChange={() => {
              setValue(name);
              setError(null);
              setOpen(true);
            }}
          />
        }
      />
      <FormDialog open={open} onOpenChange={setOpen} title="Name" submitLabel="Save" busy={busy} error={error} onSubmit={save}>
        <Input aria-label="Name" value={value} maxLength={60} placeholder={username} onChange={(e) => setValue(e.target.value)} autoFocus />
      </FormDialog>
    </>
  );
}

/**
 * The name typed at sign-in (PATCH /api/account-profile). The username stays the id. The
 * current password is asked, as the password change asks it; the server checks it and changes nothing when it is wrong.
 */
function SignInNameRow({ login, onSaved }: { login: string; onSaved: (login: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = signInNameProblem(value);
  const save = async () => {
    // the field is marked and says why under it
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/account-profile", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ login: value.trim().toLowerCase(), password }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; login?: string };
      if (!r.ok) throw failure(r, d);
      onSaved(d.login ?? value.trim().toLowerCase());
      setPassword("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        id="sign-in-name"
        title="Sign-in name"
        control={
          <Value
            text={login}
            label="Change sign-in name"
            onChange={() => {
              setValue("");
              setPassword("");
              setError(null);
              setOpen(true);
            }}
          />
        }
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Sign-in name"
        submitLabel="Save"
        busy={busy}
        error={error}
        onSubmit={save}
      >
        <Input aria-label="New sign-in name" placeholder="New sign-in name" value={value} maxLength={24} autoFocus required aria-invalid={!!problem} onChange={(e) => setValue(e.target.value)} />
        {problem && <p className="text-xs text-muted-foreground">{problem}</p>}
        <Input type="password" autoComplete="current-password" aria-label="Current password" placeholder="Current password" value={password} required onChange={(e) => setPassword(e.target.value)} />
      </FormDialog>
    </>
  );
}

/** Password: the value is never shown; [Change] opens the dialog that takes the current and the new password. */
function PasswordRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row id="password" title="Password" control={<Value text="••••••••" label="Change password" onChange={() => setOpen(true)} />} />
      <PasswordDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/password", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ current, password: next }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw failure(r, d);
      toast.success("Password changed");
      setCurrent("");
      setNext("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change it");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Password"
      description="Signs this account out everywhere else."
      submitLabel="Save"
      busy={busy}
      error={error}
      onSubmit={submit}
    >
      <Input name="current" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
      <Input name="next" type="password" autoComplete="new-password" placeholder="New password (10+ characters)" aria-label="New password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
    </FormDialog>
  );
}
