import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Advanced, Card, ErrorRow, ListRow, LoadingRow, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { ApifyKeyRow } from "./ApiKeysSection";
import { PlatformLogo } from "./PlatformLogos";
import { fmtAgo, msg } from "./helpers";
import type { SearchRowId } from "./search";

const ENV: Record<LoginKind, string> = {
  meta: "META_APP_ID + META_APP_SECRET",
  google: "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET",
  tiktok: "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET",
};
const SIGN_IN: Record<LoginKind, string> = { meta: "Sign in with Facebook", google: "Sign in with YouTube", tiktok: "Sign in with TikTok" };
const n = (v?: number) => (v === undefined ? "" : v >= 10_000 ? `${Math.round(v / 1000).toLocaleString("en-US")}k` : v.toLocaleString("en-US"));
/** "@name", whether the handle was stored with its @ or without. */
const at = (handle: string) => `@${handle.replace(/^@+/, "")}`;
const label = (p: SocialPlatform) => PLATFORMS.find((x) => x.id === p)!.label;
const NOUN: Record<SocialPlatform, string> = { instagram: "an Instagram", facebook: "a Facebook", youtube: "a YouTube", tiktok: "a TikTok", x: "an X" };
const loginOf = (p: SocialPlatform): LoginKind | undefined => PLATFORMS.find((x) => x.id === p)?.login;

/** The sign-in items this server has an app for (the login is the platform's own: Meta covers Facebook and Instagram). */
export function signInItems(logins: Record<LoginKind, boolean>): Array<{ id: LoginKind; label: string }> {
  return LOGINS.filter((l) => logins[l.id]).map((l) => ({ id: l.id, label: SIGN_IN[l.id] }));
}

/** What a platform row's button does: the one route this server can take for that platform, from its sign-in apps and the Apify key. */
export interface PlatformRow {
  platform: SocialPlatform;
  label: string;
  /** One line: how this server reads the platform, and whether the person's own sign-in is among the ways. */
  summary: string;
  /** "Add" opens the platform's dialog (or its handle field); "Add key" goes to API keys; "Open Analyzer" goes to the Content Analyzer. */
  button: "Add" | "Add key" | "Open Analyzer";
  /** Following by @handle needs the Apify key, and the key is missing: amber, and the button adds it. */
  needsKey: boolean;
  /** Accounts the person has connected on this platform. */
  connected: number;
}

/**
 * The platform list (Settings → Social accounts), one row per platform the app can read, in the order of PLATFORMS.
 * Instagram is read through its sign-in and the Content Analyzer (public Instagram accounts are added there). The other
 * platforms follow a public account by @handle with the Apify key; a sign-in to the platform's own account is added where
 * this server has that sign-in app set up.
 */
export function platformRows(view: Pick<ConnectorsView, "logins" | "apify" | "accounts">): PlatformRow[] {
  return PLATFORMS.map((p): PlatformRow => {
    const loginOn = !!p.login && !!view.logins[p.login];
    const connected = view.accounts.filter((a) => a.platform === p.id).length;
    if (p.id === "instagram") {
      return {
        platform: p.id,
        label: p.label,
        summary: loginOn ? "Your account by sign-in, others in the Content Analyzer" : "Public accounts, in the Content Analyzer",
        button: loginOn ? "Add" : "Open Analyzer",
        needsKey: false,
        connected,
      };
    }
    const apifyOk = view.apify.configured && view.apify.valid !== false;
    const own = p.id === "facebook" ? "Your Pages by sign-in" : p.id === "youtube" ? "Your channel by sign-in" : p.id === "tiktok" ? "Your account by sign-in" : "";
    const summary = loginOn ? `${own}, others by @handle` : p.id === "x" ? "Public accounts, by @handle" : p.id === "facebook" ? "Public Pages, by @handle" : p.id === "youtube" ? "Public channels, by @handle" : "Public accounts, by @handle";
    // no sign-in here: the handle is the only way, so without a working Apify key the button is the key
    const needsKey = !loginOn && !apifyOk;
    return { platform: p.id, label: p.label, summary, button: needsKey ? "Add key" : "Add", needsKey, connected };
  });
}

/**
 * Settings → Social accounts: the platforms the app reads (one row each, with its real mark and one button), then the
 * accounts connected on them. `back` = where a sign-in returns (the setup dialog passes its own step). `compact` = the
 * setup dialog's version: the Apify row and the sign-ins, nothing else.
 */
export function ConnectorsSection({ back = "/settings/connectors", compact }: { sub?: string; back?: string; compact?: boolean }) {
  // the sign-in apps are the hosted server's (on a computer the owner's own install has none to show)
  const isAdmin = useAuth((s) => s.me?.role) === "admin";
  const hosted = useAuth((s) => s.hosted);
  const admin = isAdmin && hosted;
  const projects = useWorkspace((s) => s.projects);
  const navigate = useNavigate();
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ platform: SocialPlatform; step: "choose" | "handle"; seq: number }>({ platform: "tiktok", step: "handle", seq: 0 });
  const [open, setOpen] = useState(false);
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
      <Section title="Platforms">
        <Card>{error ? <ErrorRow title="Couldn't load your accounts" detail={error} retry={() => (setError(null), void reload())} /> : <LoadingRow />}</Card>
      </Section>
    );
  }

  const rows = platformRows(view);
  const choose = (platform: SocialPlatform) => {
    const loginOn = !!loginOf(platform) && !!view.logins[loginOf(platform)!];
    setDlg({ platform, step: loginOn ? "choose" : "handle", seq: dlg.seq + 1 });
    setOpen(true);
  };

  return (
    <>
      <Section id="social-platforms" title="Platforms">
        <Card>
          {rows.map((r) => (
            <ListRow
              key={r.platform}
              id={`platform-${r.platform}` as SearchRowId}
              icon={<PlatformLogo platform={r.platform} className="size-4" />}
              title={r.label}
              subtitle={r.summary}
              status={
                r.needsKey ? (
                  <Status tone="attention">Needs your Apify key</Status>
                ) : r.connected ? (
                  <Status>{r.connected} connected</Status>
                ) : undefined
              }
              actions={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`${r.button} ${r.label}`}
                  onClick={() => (r.button === "Add key" ? navigate("/settings/keys") : r.button === "Open Analyzer" ? navigate(analyzerHome()) : choose(r.platform))}
                >
                  {r.button}
                </Button>
              }
            />
          ))}
        </Card>
      </Section>

      {view.accounts.length > 0 && (
        <Section id="your-accounts" title="Accounts">
          <Card>
            {view.accounts.map((a) => (
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
            ))}
          </Card>
        </Section>
      )}

      {admin && (
        <Card>
          <Advanced summary="Sign-in apps on this server">
            <SignInApps view={view} />
          </Advanced>
        </Card>
      )}

      <AddDialog
        key={dlg.seq}
        open={open}
        onOpenChange={setOpen}
        platform={dlg.platform}
        startStep={dlg.step}
        view={view}
        back={back}
        projectId={projectId()}
        onDone={() => void reload().then(watch)}
      />
    </>
  );
}

const choiceCls =
  "flex w-full flex-col gap-0.5 rounded-lg border border-border/60 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Add an account on one platform. Two ways when the platform has a sign-in on this server (its own account, or someone's
 * public account by @handle); one way otherwise (the handle field, with the platform already known).
 */
function AddDialog({ open, onOpenChange, platform, startStep, view, back, projectId, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  platform: SocialPlatform;
  startStep: "choose" | "handle";
  view: ConnectorsView;
  back: string;
  projectId?: string;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(startStep);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = loginOf(platform);
  const configured = view.apify.configured && view.apify.valid !== false;
  const title = `Add ${NOUN[platform]} account`;
  const close = () => onOpenChange(false);

  const submit = async () => {
    if (!configured) {
      close();
      navigate("/settings/keys");
      return;
    }
    if (!handle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addHandle(platform, handle.trim(), projectId);
      setHandle("");
      close();
      toast(`Following ${at(handle.trim())}. Reading its posts now.`);
      onDone();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...(step === "handle" ? {} : { "aria-describedby": undefined })} className="sm:max-w-md">
        {step === "choose" ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              {login && view.logins[login] && (
                <a href={loginHref(login, { back, projectId })} className={choiceCls}>
                  <span className="text-sm font-medium">My own account: {SIGN_IN[login].replace("Sign in with ", "sign in with ")}</span>
                  <span className="text-xs text-muted-foreground">{LOGINS.find((l) => l.id === login)!.gives.replace(/^./, (c) => c.toUpperCase())}.</span>
                </a>
              )}
              {platform === "instagram" ? (
                <button type="button" className={choiceCls} onClick={() => (close(), navigate(analyzerHome()))}>
                  <span className="text-sm font-medium">Someone's public account</span>
                  <span className="text-xs text-muted-foreground">Added in the Content Analyzer.</span>
                </button>
              ) : (
                <button type="button" className={choiceCls} onClick={() => setStep("handle")}>
                  <span className="text-sm font-medium">Someone's public account</span>
                  <span className="text-xs text-muted-foreground">{configured ? "Type its @handle. Reads its public posts with your Apify key." : "Needs your Apify key first."}</span>
                </button>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {configured ? `Type its @handle or profile link. Reads its public posts with your Apify key.` : "Reading public posts needs your Apify key. Add it first."}
              </DialogDescription>
            </DialogHeader>
            {configured && (
              <Input aria-label="@handle or profile link" placeholder="@handle or profile link" value={handle} onChange={(e) => setHandle(e.target.value)} autoFocus className="h-8" />
            )}
            {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <DialogFooter>
              {startStep === "choose" && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep("choose")}>
                  Back
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Saving…" : configured ? "Add account" : "Add key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
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
  const read = a.pulledAt && !a.pulling ? `read ${fmtAgo(a.pulledAt)}` : "reading…";
  const subtitle = [label(a.platform), s.followers !== undefined ? `${n(s.followers)} followers` : "", read].filter(Boolean).join(" · ");
  const login = loginOf(a.platform);
  const needsSignIn = a.loginStatus === "needs_reconnect";
  const status: ReactNode = a.pullError ? <Status tone="broken">{a.pullError}</Status> : needsSignIn ? <Status tone="attention">Sign in again to keep reading it</Status> : undefined;
  return (
    <ListRow
      icon={<PlatformLogo platform={a.platform} className="size-4" />}
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
