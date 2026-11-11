import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { logout, useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, UserRound } from "lucide-react";
import { PROVIDER_NAME, ProviderMark, type Provider } from "@/components/ProviderMark";
import { SIGN_IN_BUTTON, useMacAccount } from "@/components/setup/AccountStep";
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
  if (linked && linked in PROVIDER_NAME) return { tone: "success", text: `${PROVIDER_NAME[linked as Provider]} is linked to your account.` };
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

/** Settings → Account: the photo, name, sign-in name and password; the connected accounts (Google, Apple, GitHub); sign out. */
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
          <EmptyRow title="This computer has no account" />
        </Card>
      </Section>
    );
  }
  // everything the page shows is loaded before it is drawn, so nothing moves in after
  if (!account || !providers) return <LoadingRow />;

  const linkable = PROVIDERS.filter((p) => providers[p]);
  const shownName = account.name || account.username;
  const photo = account.signins.find((s) => s.picture);
  const saved = (name: string) => {
    setAccount((a) => ({ ...a, name }));
    useAuth.getState().setAuth(required, { ...me, name: name || me.username });
  };

  return (
    <>
      <Section title="Profile">
        <Card>
          {photo?.picture && (
            <Row id="photo" title="Photo" description={`From ${PROVIDER_NAME[photo.provider]}`} control={<AccountAvatar picture={photo.picture} initial={shownName.charAt(0)} className="size-10" />} />
          )}
          <NameRow name={account.name} username={account.username} onSaved={saved} />
          {required && <SignInNameRow login={account.login} onSaved={(login) => setAccount((a) => ({ ...a, login }))} />}
          {required && <PasswordRow />}
        </Card>
      </Section>

      <ConnectedAccounts
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
            <Row id="sign-out" title="This device" control={<Button size="sm" variant="outline" onClick={() => void logout()}>Sign out</Button>} />
          </Card>
        </Section>
      )}
    </>
  );
}

const isProvider = (p: string | undefined): p is Provider => !!p && (PROVIDERS as string[]).includes(p);

/**
 * Connected accounts: each sign-in this account has, with the provider's mark, who it is there and its own menu, then
 * a Continue with … button (the provider's mark) for each one still open. On a server with sign-in set up they are the account's linked sign-ins
 * (Unlink; a Continue with … button links another). In the Mac app it is also the Creator Toolset account this Mac is signed in
 * to (Sign out; its button signs in, only for a sign-in the Mac app offers). Nothing connected and nothing to
 * connect means no section at all, so it is never a dead row.
 */
function ConnectedAccounts({ signins, open, unlink }: { signins: SignIn[]; open: Provider[]; unlink: (p: Provider) => Promise<void> }) {
  const mac = useMacAccount({ first: "offered" });
  const macIn = mac.account.state === "signedIn" ? mac.account : null;
  // a provider this server links is its button; the Mac app's own account sign-in only for one the server does not
  const macOpen = macIn ? [] : mac.providers.filter((p) => !open.includes(p));
  // a sign-in from here that failed says so once (the sheet being closed is nothing to report)
  const failed = mac.account.state === "error" ? mac.account.message || "The sign-in didn't work. Try again." : mac.account.state === "unreachable" ? "Couldn't reach the account server. Try again." : null;
  useEffect(() => {
    if (failed) toast.error(failed);
  }, [failed]);
  if (!signins.length && !macIn && !open.length && !macOpen.length) return null;
  const mark = (p: Provider | undefined) => (
    <span className="text-foreground">{p ? <ProviderMark provider={p} className="size-4" /> : <UserRound className="size-4" />}</span>
  );
  return (
    <Section id="sign-in-with" title="Connected accounts">
      <Card>
        {signins.map((s) => (
          <ListRow
            key={s.provider}
            icon={mark(s.provider)}
            title={PROVIDER_NAME[s.provider]}
            subtitle={[s.name, s.email].filter(Boolean).join(" · ") || undefined}
            actions={
              <RowMenu
                label={`More for ${PROVIDER_NAME[s.provider]}`}
                items={[{ label: "Unlink", destructive: true, confirm: { title: `Unlink ${PROVIDER_NAME[s.provider]} from your account?`, body: "You can link it again any time.", ok: "Unlink" }, onSelect: () => unlink(s.provider) }]}
              />
            }
          />
        ))}
        {macIn && (
          <ListRow
            icon={mark(isProvider(macIn.provider) ? macIn.provider : undefined)}
            title={isProvider(macIn.provider) ? PROVIDER_NAME[macIn.provider] : "Creator Toolset account"}
            subtitle={[macIn.name, macIn.email].filter(Boolean).join(" · ") || undefined}
            actions={<RowMenu label="More for this account" items={[{ label: "Sign out", onSelect: async () => mac.signOut() }]} />}
          />
        )}
        {(open.length > 0 || macOpen.length > 0) && (
          <div className="flex flex-col gap-2 p-2 sm:flex-row">
            {open.map((p) => (
              <a key={`link-${p}`} href={`/api/account/login/${p}?for=link`} className={cn(SIGN_IN_BUTTON, "sm:flex-1")}>
                <ProviderMark provider={p} className="size-4 shrink-0" />
                <span>Continue with {PROVIDER_NAME[p]}</span>
              </a>
            ))}
            {macOpen.map((p) => (
              <button key={`mac-${p}`} type="button" disabled={!!mac.busy} onClick={() => mac.signIn(p)} className={cn(SIGN_IN_BUTTON, "sm:flex-1", mac.busy && mac.busy !== p && "opacity-50")}>
                {mac.busy === p ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ProviderMark provider={p} className="size-4 shrink-0" />}
                <span>{mac.busy === p ? "Signing in…" : `Continue with ${PROVIDER_NAME[p]}`}</span>
              </button>
            ))}
          </div>
        )}
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
      <FormDialog open={open} onOpenChange={setOpen} title="Name" submitLabel="Save name" busy={busy} error={error} onSubmit={save}>
        <Input aria-label="Name" value={value} maxLength={60} placeholder={username} onChange={(e) => setValue(e.target.value)} autoFocus />
      </FormDialog>
    </>
  );
}

/**
 * The name typed at sign-in (PATCH /api/account-profile). A new one moves no files: the username stays the id. The
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
        description="You sign in with this name from now on. Your files stay where they are."
        submitLabel="Save sign-in name"
        submitDisabled={!value.trim() || !!problem || !password}
        busy={busy}
        error={error}
        onSubmit={save}
      >
        <Input aria-label="New sign-in name" placeholder="New sign-in name" value={value} maxLength={24} autoFocus onChange={(e) => setValue(e.target.value)} />
        {problem && <p className="text-xs text-muted-foreground">{problem}</p>}
        <Input type="password" autoComplete="current-password" aria-label="Current password" placeholder="Current password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
      toast.success("Password changed. Other devices are signed out.");
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
      title="Change password"
      description="Your other devices sign in again with the new one."
      submitLabel="Change password"
      busy={busy}
      error={error}
      onSubmit={submit}
    >
      <Input name="current" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
      <Input name="next" type="password" autoComplete="new-password" placeholder="New password (6+ characters)" aria-label="New password" minLength={6} value={next} onChange={(e) => setNext(e.target.value)} required />
    </FormDialog>
  );
}
