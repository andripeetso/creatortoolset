import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addAccount as addInstagram, analyzerHome, patchAccount as patchInstagram } from "@/lib/instagram";
import { patchProject } from "@/lib/workshop";
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
  type OwnInstagram,
  type SocialPlatform,
} from "@/lib/connectors";
import { Card, ErrorRow, ListRow, LoadingRow, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { ApifyKeyRow } from "./ApiKeysSection";
import { PlatformLogo } from "./PlatformLogos";
import { msg } from "./helpers";
import type { SearchRowId } from "./search";

const SIGN_IN: Record<LoginKind, string> = { meta: "Sign in with Facebook", google: "Sign in with YouTube", tiktok: "Sign in with TikTok" };
const n = (v?: number) => (v === undefined ? "" : v >= 10_000 ? `${Math.round(v / 1000).toLocaleString("en-US")}k` : v.toLocaleString("en-US"));
/** "@name", whether the handle was stored with its @ or without. */
const at = (handle: string) => `@${handle.replace(/^@+/, "")}`;
const NOUN: Record<SocialPlatform, string> = { instagram: "an Instagram", facebook: "a Facebook", youtube: "a YouTube", tiktok: "a TikTok", x: "an X" };
const loginOf = (p: SocialPlatform): LoginKind | undefined => PLATFORMS.find((x) => x.id === p)?.login;

/** The sign-in items this server has an app for (the login is the platform's own: Meta covers Facebook and Instagram). */
export function signInItems(logins: Record<LoginKind, boolean>): Array<{ id: LoginKind; label: string }> {
  return LOGINS.filter((l) => logins[l.id]).map((l) => ({ id: l.id, label: SIGN_IN[l.id] }));
}

/** One platform for one project: its account, or the one way this server can add one (sign-in apps, the Apify key). */
export interface PlatformRow {
  platform: SocialPlatform;
  label: string;
  /** The account's @handle and numbers, or how an account is added on this server. */
  summary: string;
  /** "Add" opens the platform's dialog (or its handle field); "Add key" goes to API keys; none = an account is there. */
  button?: "Add" | "Add key";
  /** Following by @handle needs the Apify key, and the key is missing: amber, and the button adds it. */
  needsKey: boolean;
  /** The project's account on this platform (one per platform per project). */
  account?: ConnectedAccount;
  /** Instagram: the project's own account in the Analyzer, when no sign-in account is there. */
  own?: OwnInstagram;
}

/**
 * Settings → Social accounts for one project: one row per platform, in the order of PLATFORMS, each with the project's one
 * account or its Add button. An account linked to no project shows in every project until one is added there. Instagram
 * is the person's own account: its sign-in, else the Analyzer account the project links (or the one marked Mine that no
 * project links).
 */
export function platformRows(view: Pick<ConnectorsView, "logins" | "apify" | "accounts" | "instagram">, projectId?: string): PlatformRow[] {
  const apifyOk = view.apify.configured && view.apify.valid !== false;
  return PLATFORMS.flatMap((p): PlatformRow[] => {
    const loginOn = !!p.login && !!view.logins[p.login];
    const on = view.accounts.filter((a) => a.platform === p.id);
    // ponytail: a Meta sign-in can bring several Pages into one project; the row shows the first
    const account = on.find((a) => !!projectId && a.projectId === projectId) ?? on.find((a) => !a.projectId);
    if (account) {
      const f = account.stats?.followers;
      return [{ platform: p.id, label: p.label, summary: [at(account.handle), f !== undefined ? `${n(f)} followers` : ""].filter(Boolean).join(" · "), needsKey: false, account }];
    }
    if (p.id === "instagram") {
      const own = view.instagram.find((x) => !!projectId && x.projectId === projectId) ?? view.instagram.find((x) => x.mine && !x.projectId);
      if (own) return [{ platform: p.id, label: p.label, summary: [at(own.handle), own.followers !== undefined ? `${n(own.followers)} followers` : ""].filter(Boolean).join(" · "), needsKey: false, own }];
      return [{ platform: p.id, label: p.label, summary: loginOn ? "Your account by sign-in, or by @handle" : "Your account, by @handle", button: "Add", needsKey: false }];
    }
    const own = p.id === "facebook" ? "Your Pages by sign-in" : p.id === "youtube" ? "Your channel by sign-in" : "Your account by sign-in";
    const summary = loginOn ? `${own}, or by @handle` : p.id === "facebook" ? "Public Pages, by @handle" : p.id === "youtube" ? "Public channels, by @handle" : "Public accounts, by @handle";
    // no sign-in here: the handle is the only way, so without a working Apify key the button is the key
    const needsKey = !loginOn && !apifyOk;
    return [{ platform: p.id, label: p.label, summary, button: needsKey ? "Add key" : "Add", needsKey }];
  });
}

/**
 * Settings → Social accounts: the platforms the app reads for the project picked above them, one row each with the
 * project's account (its … menu) or one button. `back` = where a sign-in returns (the setup dialog passes its own step). `compact` = the
 * setup dialog's version: the Apify row and the sign-ins, nothing else.
 */
export function ConnectorsSection({ back = "/settings/connectors", compact }: { sub?: string; back?: string; compact?: boolean }) {
  const projects = useWorkspace((s) => s.projects);
  const current = useWorkspace((s) => s.currentProjectId);
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

  const rows = platformRows(view, current ?? undefined);
  const choose = (platform: SocialPlatform) => {
    const loginOn = !!loginOf(platform) && !!view.logins[loginOf(platform)!];
    setDlg({ platform, step: loginOn ? "choose" : "handle", seq: dlg.seq + 1 });
    setOpen(true);
  };

  return (
    <>
      <Section
        id="social-platforms"
        title="Platforms"
        action={
          projects.length > 1 && (
            <SettingsSelect
              label="Project"
              value={current ?? ""}
              onValueChange={(id) => void useWorkspace.getState().select(id).catch((e) => saveFailed(msg(e)))}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          )
        }
      >
        <Card>
          {rows.map((r) =>
            r.own ? (
              <ListRow
                key={r.platform}
                id={`platform-${r.platform}` as SearchRowId}
                icon={<PlatformLogo platform={r.platform} className="size-4" />}
                title={r.label}
                subtitle={r.summary}
                actions={
                  <RowMenu
                    label={`${at(r.own.handle)} actions`}
                    items={[
                      { label: "Open in the Analyzer", onSelect: () => navigate(`${analyzerHome()}/accounts/${r.own!.id}`) },
                      // not "my account" any more: the Analyzer keeps it as a followed account, no project links it
                      { label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${at(r.own.handle)}?`, body: "Its numbers stop updating here.", ok: "Disconnect" }, onSelect: () => void act(patchInstagram(r.own!.id, { mine: false })) },
                    ]}
                  />
                }
              />
            ) : r.account ? (
              <AccountRow
                key={r.platform}
                row={r}
                a={r.account}
                back={back}
                onLink={() => act(linkAccount(r.account!.key, current))}
                onPull={() => void act(pullAccountNow(r.account!.key).then(watch))}
                onRemove={() => act(disconnectAccount(r.account!.key))}
                onOpen={() => navigate(`${analyzerHome()}/accounts/${r.account!.analyzerId}`)}
              />
            ) : (
              <ListRow
                key={r.platform}
                id={`platform-${r.platform}` as SearchRowId}
                icon={<PlatformLogo platform={r.platform} className="size-4" />}
                title={r.label}
                subtitle={r.summary}
                status={r.needsKey ? <Status tone="attention">Needs your Apify key</Status> : undefined}
                actions={
                  r.button && (
                    <Button size="xs" variant="outline" aria-label={`${r.button} ${r.label}`} onClick={() => (r.button === "Add key" ? navigate("/settings/keys") : choose(r.platform))}>
                      {r.button}
                    </Button>
                  )
                }
              />
            ),
          )}
        </Card>
      </Section>

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
  // Instagram by handle goes to the Analyzer, which reads your own account through the server's token or your Apify key
  const ig = platform === "instagram";
  const configured = ig || (view.apify.configured && view.apify.valid !== false);
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
      if (ig) {
        const a = await addInstagram(handle.trim(), { run: "now", mine: !view.instagram.some((x) => x.mine) });
        if (projectId) await patchProject(projectId, { accountId: a.id });
      } else await addHandle(platform, handle.trim(), projectId);
      setHandle("");
      close();
      toast(`${ig ? "Connected" : "Following"} ${at(handle.trim())}. Reading its posts now.`);
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
                <button type="button" className={choiceCls} onClick={() => setStep("handle")}>
                  <span className="text-sm font-medium">My own account, by @handle</span>
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
                {ig ? "Type your @handle or profile link." : configured ? "Type its @handle or profile link. Reads its public posts with your Apify key." : "Reading public posts needs your Apify key. Add it first."}
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

/** A platform row with the project's account: its numbers, a sign-in that ran out, and its … menu. */
function AccountRow({ row, a, back, onLink, onPull, onRemove, onOpen }: {
  row: PlatformRow;
  a: ConnectedAccount;
  back: string;
  onLink: () => void;
  onPull: () => void;
  onRemove: () => Promise<unknown>;
  onOpen: () => void;
}) {
  const login = loginOf(a.platform);
  const needsSignIn = a.loginStatus === "needs_reconnect";
  const status: ReactNode = a.pullError ? <Status tone="broken">{a.pullError}</Status> : needsSignIn ? <Status tone="attention">Sign in again to keep reading it</Status> : undefined;
  return (
    <ListRow
      id={`platform-${a.platform}` as SearchRowId}
      icon={<PlatformLogo platform={a.platform} className="size-4" />}
      title={row.label}
      subtitle={row.summary}
      status={status}
      actions={
        <>
          {needsSignIn && login && (
            <Button asChild size="xs" variant="outline">
              <a href={loginHref(login, { back })}>Sign in again</a>
            </Button>
          )}
          <RowMenu
            label={`${at(a.handle)} actions`}
            items={[
              { label: "Read again", icon: <RefreshCw />, onSelect: onPull },
              // an account linked to no project shows in each one: this keeps it in the one picked
              ...(!a.projectId ? [{ label: "Link to this project", onSelect: onLink }] : []),
              ...(a.platform === "instagram" && a.analyzerId ? [{ label: "Open in the Analyzer", onSelect: onOpen }] : []),
              { label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${at(a.handle)}?`, body: "Its numbers stop updating here.", ok: "Disconnect" }, onSelect: () => void onRemove() },
            ]}
          />
        </>
      }
    />
  );
}
