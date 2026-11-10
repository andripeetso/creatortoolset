import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AtSign, Copy, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";
import { analyzerHome } from "@/lib/instagram";
import { useWorkspace } from "@/lib/workspace";
import {
  LOGINS,
  PLATFORMS,
  addHandle,
  disconnectAccount,
  getConnectors,
  linkAccount,
  loginHref,
  pullAccountNow,
  type ConnectedAccount,
  type ConnectorsView,
  type LoginKind,
  type SocialPlatform,
} from "@/lib/connectors";
import { Advanced, Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { ApifyKeyRow } from "./ApiKeysSection";
import { fmtAgo, msg } from "./helpers";

const ENV: Record<LoginKind, string> = {
  meta: "META_APP_ID + META_APP_SECRET",
  google: "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET",
  tiktok: "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET",
};
const SIGN_IN: Record<LoginKind, string> = { meta: "Sign in with Instagram", google: "Sign in with YouTube", tiktok: "Sign in with TikTok" };
/** Follow by handle reads the platforms Apify reads; Instagram is read through its own sign-in and the Analyzer. */
const FOLLOW_PLATFORMS = PLATFORMS.filter((p) => p.id !== "instagram");
const n = (v?: number) => (v === undefined ? "" : v >= 10_000 ? `${Math.round(v / 1000).toLocaleString("en-US")}k` : v.toLocaleString("en-US"));

/** The sign-in items the add menu offers: only the logins this server has an app for. */
/** "@name", whether the handle was stored with its @ or without. */
const at = (handle: string) => `@${handle.replace(/^@+/, "")}`;

export function signInItems(logins: Record<LoginKind, boolean>): Array<{ id: LoginKind; label: string }> {
  return LOGINS.filter((l) => logins[l.id]).map((l) => ({ id: l.id, label: SIGN_IN[l.id] }));
}

/** The login an account signs in again with (its platform's login), if the platform has one. */
const loginOf = (p: SocialPlatform): LoginKind | undefined => PLATFORMS.find((x) => x.id === p)?.login;

/**
 * Settings → Social accounts: accounts you sign in to (their own numbers) or follow by handle (public numbers, read with
 * the Apify key on API keys). `back` = where a sign-in returns (the setup dialog passes its own step). `compact` = the setup
 * dialog's version: the Apify row and the sign-ins, nothing else.
 */
export function ConnectorsSection({ back = "/settings/connectors", compact }: { sub?: string; back?: string; compact?: boolean }) {
  const admin = useAuth((s) => s.me?.role) === "admin";
  const projects = useWorkspace((s) => s.projects);
  const navigate = useNavigate();
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [params, setParams] = useSearchParams();

  const reload = useCallback(() => getConnectors().then(setView).catch((e) => setError(msg(e))), []);
  useEffect(() => void reload(), [reload]);
  // a pull runs on the server: look again a few times
  const watch = () => [4, 10, 25, 60].forEach((s) => window.setTimeout(() => void reload(), s * 1000));
  const act = (p: Promise<unknown>) => p.then(reload).catch((e) => saveFailed(msg(e)));
  const projectId = () => useWorkspace.getState().currentProjectId ?? undefined;

  // the sign-in comes back here with the result: say it once, then drop it from the address
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("error");
    if (!connected && !failed) return;
    if (failed) saveFailed(failed);
    else {
      toast(`${connected} account(s) connected: reading their numbers now`);
      watch();
    }
    setParams((p) => (p.delete("connected"), p.delete("error"), p), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (compact) {
    return (
      <Card>
        <ApifyKeyRow onChanged={() => void reload()} />
        {LOGINS.filter((l) => view?.logins[l.id]).map((l) => (
          <ListRow
            key={l.id}
            title={SIGN_IN[l.id]}
            subtitle={l.gives}
            actions={
              <Button asChild size="xs" variant="outline">
                <a href={loginHref(l.id, { back, projectId: projectId() })}>Sign in</a>
              </Button>
            }
          />
        ))}
      </Card>
    );
  }

  if (!view) {
    return (
      <Section title="Your accounts">
        <Card>{error ? <ErrorRow title="Couldn't load your accounts" detail={error} retry={() => (setError(null), void reload())} /> : <LoadingRow />}</Card>
      </Section>
    );
  }

  return (
    <>
      <Section
        id="your-accounts"
        title="Your accounts"
        action={
          <AddAccount
            logins={view.logins}
            back={back}
            projectId={projectId()}
            onFollow={() => setFollow(true)}
          />
        }
      >
        <Card>
          {view.accounts.length === 0 ? (
            <EmptyRow title="No accounts yet" description="Connect an account to see its posts, reach and saves in the Analyzer." />
          ) : (
            view.accounts.map((a) => (
              <AccountRow
                key={a.key}
                a={a}
                projects={projects}
                back={back}
                onLink={(pid) => act(linkAccount(a.key, pid))}
                onPull={() => void act(pullAccountNow(a.key).then(watch))}
                onRemove={() => act(disconnectAccount(a.key))}
                onOpen={() => navigate(`${analyzerHome()}/accounts/${a.analyzerId}`)}
              />
            ))
          )}
        </Card>
      </Section>

      {admin && (
        <Card>
          <Advanced summary="Sign-in apps on this server">
            <SignInApps view={view} />
          </Advanced>
        </Card>
      )}

      <FollowDialog open={follow} onOpenChange={setFollow} configured={view.apify.configured} projectId={projectId()} onDone={() => void reload().then(watch)} />
    </>
  );
}

function AddAccount({ logins, back, projectId, onFollow }: { logins: Record<LoginKind, boolean>; back: string; projectId?: string; onFollow: () => void }) {
  const signIns = signInItems(logins);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost">
          <Plus className="size-3" /> Add account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {signIns.map((l) => (
          <DropdownMenuItem key={l.id} asChild className="text-sm">
            <a href={loginHref(l.id, { back, projectId })}>{l.label}</a>
          </DropdownMenuItem>
        ))}
        {signIns.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onFollow} className="text-sm">
          Follow by @handle
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Follow by handle: needs the Apify key. Without it the dialog says so, and its button goes to API keys. */
function FollowDialog({ open, onOpenChange, configured, projectId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; configured: boolean; projectId?: string; onDone: () => void }) {
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<SocialPlatform>("tiktok");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!configured) {
      onOpenChange(false);
      navigate("/settings/keys");
      return;
    }
    if (!handle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addHandle(platform, handle.trim(), projectId);
      setHandle("");
      onOpenChange(false);
      toast(`Following ${handle.trim()}. Reading its posts now.`);
      onDone();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
      title="Follow by @handle"
      description={configured ? "Reads their public posts with your Apify key." : "Following by handle reads public posts with your Apify key. Add it first."}
      submitLabel={configured ? "Follow" : "Add key"}
      onSubmit={submit}
      busy={busy}
      error={error}
    >
      {configured && (
        <>
          <SettingsSelect label="Platform" value={platform} onValueChange={(v) => setPlatform(v as SocialPlatform)} options={FOLLOW_PLATFORMS.map((p) => ({ value: p.id, label: p.label }))} className="sm:w-full" />
          <Input aria-label="@handle or profile link" placeholder="@handle or profile link" value={handle} onChange={(e) => setHandle(e.target.value)} autoFocus className="h-8" />
        </>
      )}
    </FormDialog>
  );
}

function AccountRow({ a, projects, back, onLink, onPull, onRemove, onOpen }: {
  a: ConnectedAccount;
  projects: Array<{ id: string; name: string }>;
  back: string;
  onLink: (projectId: string | null) => void;
  onPull: () => void;
  onRemove: () => Promise<unknown>;
  onOpen: () => void;
}) {
  const s = a.stats ?? {};
  const subtitle = [s.followers !== undefined ? `${n(s.followers)} followers` : "", a.pulledAt && !a.pulling ? `read ${fmtAgo(a.pulledAt)}` : "reading…"].filter(Boolean).join(" · ");
  const login = loginOf(a.platform);
  const needsSignIn = a.loginStatus === "needs_reconnect";
  const status: ReactNode = a.pullError ? <Status tone="broken">{a.pullError}</Status> : needsSignIn ? <Status tone="attention">Sign in again to keep reading it</Status> : undefined;
  return (
    <ListRow
      icon={<PlatformMark platform={a.platform} />}
      title={at(a.handle)}
      subtitle={subtitle}
      status={status}
      actions={
        <>
          {needsSignIn && login && (
            <Button asChild size="xs" variant="outline">
              <a href={loginHref(login, { back })}>Sign in again</a>
            </Button>
          )}
          {a.platform !== "instagram" && (
            <SettingsSelect
              label={`Project for ${at(a.handle)}`}
              value={a.projectId ?? "none"}
              onValueChange={(v) => onLink(v === "none" ? null : v)}
              options={[{ value: "none", label: "No project" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              className="sm:w-40"
            />
          )}
          <RowMenu
            label={`${at(a.handle)} actions`}
            items={[
              { label: "Read again", icon: <RefreshCw />, onSelect: onPull },
              ...(a.platform === "instagram" && a.analyzerId ? [{ label: "Open in the Analyzer", onSelect: onOpen }] : []),
              { label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${at(a.handle)}?`, body: "Its numbers stop updating here.", ok: "Disconnect" }, onSelect: () => void onRemove() },
            ]}
          />
        </>
      }
    />
  );
}

/** Admin: each sign-in app's state, the .env names it needs, and its redirect URL with one copy button. Read-only. */
function SignInApps({ view }: { view: ConnectorsView }) {
  return (
    <>
      {LOGINS.map((l) => {
        const url = view.redirects[l.id];
        return (
          <ListRow
            key={l.id}
            title={l.label}
            subtitle={url}
            status={view.logins[l.id] ? <Status>Set in .env</Status> : <Status tone="attention">Not set. Add {ENV[l.id]} to the server's .env</Status>}
            actions={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Copy the redirect URL for ${l.label}`}
                onClick={() => void navigator.clipboard.writeText(url).then(() => toast("Copied"), () => saveFailed("Couldn't copy it. Select the address and copy it."))}
              >
                <Copy />
              </Button>
            }
          />
        );
      })}
    </>
  );
}

/** The platform's mark: simple shapes in the text colour. Facebook and X have none: the at-sign. */
function PlatformMark({ platform }: { platform: SocialPlatform }) {
  if (platform === "instagram")
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" />
      </svg>
    );
  if (platform === "youtube")
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="currentColor">
        <path fillRule="evenodd" d="M6 5h12a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4zm4 4.5v5l4.5-2.5z" />
      </svg>
    );
  if (platform === "tiktok")
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="currentColor">
        <path d="M14 3h3c.2 2.4 1.8 4.2 4.2 4.4v3.1c-1.6 0-3-.5-4.2-1.3v6.3a5.5 5.5 0 1 1-5.5-5.5c.3 0 .6 0 .9.1v3.2a2.4 2.4 0 1 0 1.6 2.2z" />
      </svg>
    );
  return <AtSign className="size-4" aria-hidden />;
}
