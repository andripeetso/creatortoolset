import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { logout, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Advanced, Card, EmptyRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, saveFailed } from "./ui";

type Provider = "google" | "apple" | "github";
const PROVIDER_NAME: Record<Provider, string> = { google: "Google", apple: "Apple", github: "GitHub" };
const PROVIDERS = Object.keys(PROVIDER_NAME) as Provider[];

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

/** GET /api/account/setup (admin, hosted): the .env names each sign-in reads and the address to register. */
interface SetupView {
  origin: string;
  signinOrigin: string;
  providers: { kind: Provider; name: string; env: string[]; redirect: string }[];
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

/** Settings → Account: the photo, name, sign-in name and password; Google, Apple and GitHub sign-in; sign out. */
export function AccountSection() {
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  const hosted = useAuth((s) => s.hosted);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [providers, setProviders] = useState<Record<Provider, boolean> | null>(null);
  const [setup, setSetup] = useState<SetupView | "failed" | null>(null);
  const [params, setParams] = useSearchParams();
  const told = useRef(false);

  // a computer with no account answers 401 here: the page then says so, instead of a name that can never save
  const load = () =>
    fetch("/api/auth/account")
      .then((r) => (r.status === 401 ? (setNoAccount(true), null) : r.ok ? (r.json() as Promise<AccountView>) : null))
      .then((d) => d && setAccount(d))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const off = Object.fromEntries(PROVIDERS.map((p) => [p, false])) as Record<Provider, boolean>;
    void fetch("/api/account/providers")
      .then((r) => (r.ok ? (r.json() as Promise<Record<Provider, boolean>>) : off))
      .then((d) => setProviders(d))
      .catch(() => setProviders(off));
  }, [required]);

  const admin = me?.role === "admin";
  const noneSetUp = !!providers && PROVIDERS.every((p) => !providers[p]);
  // only the server's admin, on a hosted server, sees how to set sign-in up
  const needSetup = hosted && admin && noneSetUp;
  useEffect(() => {
    if (!needSetup) return;
    const got = async (): Promise<SetupView | "failed"> => {
      const r = await fetch("/api/account/setup");
      return r.ok ? ((await r.json()) as SetupView) : "failed";
    };
    void got()
      .then(setSetup)
      .catch(() => setSetup("failed"));
  }, [needSetup]);

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
  if (!account || !providers || (needSetup && setup === null)) return <LoadingRow />;

  const linkable = PROVIDERS.filter((p) => providers[p]);
  const shownName = account.name || account.username;
  const photo = account.signins.find((s) => s.picture);
  const saved = (name: string) => {
    setAccount((a) => a && { ...a, name });
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
          {required && <SignInNameRow login={account.login} onSaved={(login) => setAccount((a) => a && { ...a, login })} />}
          {required && <PasswordRow />}
        </Card>
      </Section>

      {linkable.length > 0 && (
        <Section id="sign-in-with" title="Sign in with">
          <Card>
            {linkable.map((p) => {
              const s = account.signins.find((x) => x.provider === p);
              const who = s ? [s.name, s.email].filter(Boolean).join(" · ") : "";
              return (
                <Row
                  key={p}
                  title={PROVIDER_NAME[p]}
                  description={who || undefined}
                  control={
                    s ? (
                      <RowMenu
                        label={`More for ${PROVIDER_NAME[p]}`}
                        items={[
                          {
                            label: "Unlink",
                            destructive: true,
                            confirm: { title: `Unlink ${PROVIDER_NAME[p]} from your account?`, body: "You can link it again any time.", ok: "Unlink" },
                            onSelect: async () => {
                              const r = await fetch(`/api/auth/identity/${p}`, { method: "DELETE" });
                              const d = (await r.json().catch(() => ({}))) as { error?: string };
                              if (!r.ok) throw failure(r, d);
                              await load();
                            },
                          },
                        ]}
                      />
                    ) : (
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/account/login/${p}?for=link`}>Link</a>
                      </Button>
                    )
                  }
                />
              );
            })}
          </Card>
        </Section>
      )}
      {needSetup && (
        <Section id="sign-in-with" title="Sign in with">
          <Card>
            <Row id="sign-in-setup" title="No sign-in is set up on this server" description="Google, Apple or GitHub sign-in is switched on in the server's .env." />
            {setup !== "failed" && setup && (
              <Advanced summary="Set it up">
                <SetupRows setup={setup} />
              </Advanced>
            )}
          </Card>
        </Section>
      )}

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

/** The copy button of a setup line (same pattern as the sign-in apps fold on Social accounts). */
function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => toast("Copied"), () => saveFailed("Couldn't copy it. Select the text and copy it."))}
    >
      <Copy />
    </Button>
  );
}

/** Admin, no sign-in set up: the server's own address, then each provider's .env names and the address to register. */
function SetupRows({ setup }: { setup: SetupView }) {
  return (
    <>
      <ListRow
        title="SIGNIN_ORIGIN"
        subtitle={setup.origin}
        actions={<CopyButton text={setup.origin} label="Copy the SIGNIN_ORIGIN value" />}
      />
      {setup.providers.map((p) => (
        <div key={p.kind}>
          {p.env.map((name) => (
            <ListRow key={name} title={name} actions={<CopyButton text={name} label={`Copy ${name}`} />} />
          ))}
          <ListRow title={`${p.name} redirect address`} subtitle={p.redirect} actions={<CopyButton text={p.redirect} label={`Copy the ${p.name} redirect address`} />} />
        </div>
      ))}
    </>
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
