import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { logout, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { Card, EmptyRow, FormDialog, LoadingRow, Row, RowMenu, Section, TextField } from "./ui";

type Provider = "google" | "apple" | "github";
const PROVIDER_NAME: Record<Provider, string> = { google: "Google", apple: "Apple", github: "GitHub" };
const PROVIDERS = Object.keys(PROVIDER_NAME) as Provider[];

/** GET /api/auth/account: the name the app shows (empty when none was set), and the sign-ins linked to this account. */
interface AccountView {
  username: string;
  name: string;
  identities: Provider[];
}

const failure = (r: Response, d: { error?: string }) => new Error(d.error ?? `Could not save it (${r.status})`);

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

/** Settings → Account: the name, the sign-in name and password (sign-in on), Google/Apple/GitHub sign-in, and sign out. */
export function AccountSection() {
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [providers, setProviders] = useState<Record<Provider, boolean> | null>(null);
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
    void fetch("/api/account/providers")
      .then((r) => (r.ok ? (r.json() as Promise<Record<Provider, boolean>>) : null))
      .then((d) => setProviders(d))
      .catch(() => setProviders(null));
  }, [required]);

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
  if (!account) return <LoadingRow />;

  const setName = (name: string) => useAuth.getState().setAuth(required, { ...me, name: name || me.username });
  const linkable = providers ? PROVIDERS.filter((p) => providers[p]) : [];

  return (
    <>
      <Section title="Profile">
        <Card>
          <Row
            id="name"
            title="Name"
            control={
              <TextField
                label="Name"
                value={account.name}
                placeholder={account.username}
                maxLength={60}
                onCommit={async (next) => {
                  const r = await fetch("/api/auth/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }) });
                  const d = (await r.json().catch(() => ({}))) as { error?: string };
                  if (!r.ok) throw failure(r, d);
                  setAccount({ ...account, name: next.trim() });
                  setName(next.trim());
                }}
              />
            }
          />
          {required && <SignInName />}
          {required && <PasswordRow />}
        </Card>
      </Section>

      {linkable.length > 0 && (
        <Section id="sign-in-with" title="Sign in with">
          <Card>
            {linkable.map((p) => {
              const linked = account.identities.includes(p);
              return (
                <Row
                  key={p}
                  title={PROVIDER_NAME[p]}
                  control={
                    linked ? (
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
      {linkable.length === 0 && providers && hasAccountBridge() && (
        <Section title="Sign in with">
          <Card>
            <AccountStep />
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

/** The name typed at sign-in (GET/PATCH /api/account-profile): a new one moves no files, the username stays the id. */
function SignInName() {
  const [login, setLogin] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/account-profile")
      .then((r) => (r.ok ? (r.json() as Promise<{ login: string }>) : null))
      .then((d) => setLogin(d?.login ?? ""))
      .catch(() => setLogin(""));
  }, []);
  if (login === null) return null;
  return (
    <Row
      id="sign-in-name"
      title="Sign-in name"
      control={
        <TextField
          label="Sign-in name"
          value={login}
          maxLength={24}
          onCommit={async (next) => {
            const r = await fetch("/api/account-profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: next }) });
            const d = (await r.json().catch(() => ({}))) as { error?: string; login?: string };
            if (!r.ok) throw failure(r, d);
            setLogin(d.login ?? next);
          }}
        />
      }
    />
  );
}

/** Password: one Change button; the dialog takes the current and the new password (POST /api/auth/password). */
function PasswordRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row
        id="password"
        title="Password"
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Change
          </Button>
        }
      />
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
        headers: { "Content-Type": "application/json" },
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
