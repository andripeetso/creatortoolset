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
import { linkedOf, useMacAccount } from "@/components/setup/AccountStep";
import { SignInCodeRow } from "@/components/SignInCode";
import { Card, EmptyRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section } from "./ui";

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
      {required && (
        <Section title="Session">
          <Card>
            <Row id="sign-out" title="This server" description="Signs out every browser signed in to this account." control={<Button size="sm" variant="outline" onClick={() => void logout()}>Sign out</Button>} />
          </Card>
        </Section>
      )}
    </>
  );
}

const isProvider = (p: string | undefined): p is Provider => !!p && (PROVIDERS as string[]).includes(p);

/**
 * Sign-ins: each sign-in this account has, with the provider's mark, who it is there and its own menu, then a row with
 * Add for each one still open. On a server with sign-in set up they are the account's own sign-ins (Disconnect; Add
 * brings in another). The server lists a provider only where it runs sign-ins (GET /api/account/providers: none off a
 * hosted server), and only a listed provider's sign-in has a row, so Disconnect is never offered where the server's
 * route refuses it (api/auth.ts DELETE /identity/:provider). In the Mac app it is also the Creator Toolset account the
 * Mac app is signed in to (Sign out of the Mac app; its button signs in, only for a sign-in the Mac app offers), with
 * that account's other sign-ins (Disconnect) and Add for one more. Nothing there and nothing to add means no section
 * at all, so it is never a dead row.
 */
function SignIns({ signins, open, unlink }: { signins: SignIn[]; open: Provider[]; unlink: (p: Provider) => Promise<void> }) {
  const mac = useMacAccount({ first: "offered" });
  const macIn = mac.account.state === "signedIn" ? mac.account : null;
  const macLinked = linkedOf(mac.account);
  // a provider this server links is its button; the Mac app's own account sign-in only for one the server does not.
  // Signed in to the account: the ones it has no sign-in with yet, which link to it
  const macOpen = mac.providers.filter((p) => !open.includes(p) && !signins.some((s) => s.provider === p) && (!macIn || (p !== macIn.provider && !macLinked.some((l) => l.provider === p))));
  // a sign-in from here that failed says so once (the sheet being closed is nothing to report)
  const failed =
    mac.problem ??
    (mac.account.state === "error" ? mac.account.message || "Could not sign in. Try again." : mac.account.state === "unreachable" ? "Could not reach the account server. Try again." : null);
  useEffect(() => {
    if (failed) toast.error(failed);
  }, [failed]);
  if (!signins.length && !macIn && !open.length && !macOpen.length) return null;
  const mark = (p: Provider | undefined) => (
    <span className="text-foreground">{p ? <ProviderMark provider={p} className="size-4" /> : <UserRound className="size-4" />}</span>
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
        {macIn && (
          <ListRow
            icon={mark(isProvider(macIn.provider) ? macIn.provider : undefined)}
            title={isProvider(macIn.provider) ? PROVIDER_NAME[macIn.provider] : "Creator Toolset account"}
            subtitle={[macIn.name, macIn.email].filter(Boolean).join(" · ") || undefined}
            actions={<RowMenu label="Creator Toolset account actions" items={[{ label: "Sign out of the Mac app", onSelect: async () => mac.signOut() }]} />}
          />
        )}
        {macIn &&
          macLinked.map((l) => (
            <ListRow
              key={`linked-${l.provider}`}
              icon={mark(l.provider)}
              title={PROVIDER_NAME[l.provider]}
              subtitle={l.email || undefined}
              actions={
                <RowMenu
                  label={`${PROVIDER_NAME[l.provider]} actions`}
                  items={[{ label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${PROVIDER_NAME[l.provider]}?`, ok: "Disconnect" }, onSelect: () => mac.unlink(l.provider) }]}
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
        {macOpen.map((p) => (
          <ListRow
            key={`mac-${p}`}
            icon={mark(p)}
            title={PROVIDER_NAME[p]}
            actions={
              // signed in to the account already: this sign-in is added to it; else it signs the Mac app in
              <Button size="sm" variant="outline" disabled={!!mac.busy} aria-label={`${macIn ? "Add" : "Sign in with"} ${PROVIDER_NAME[p]}`} onClick={() => (macIn ? mac.link(p) : mac.signIn(p))}>
                {mac.busy === p ? "Signing in…" : macIn ? "Add" : "Sign in"}
              </Button>
            }
          />
        ))}
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
