import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addAccount as addInstagram, patchAccount as patchInstagram } from "@/lib/instagram";
import { patchProject } from "@/lib/workshop";
import { useCachedLoad } from "@/lib/local-cache";
import { useWorkspace } from "@/lib/workspace";
import {
  LOGINS,
  PLATFORMS,
  addHandle,
  disconnectAccount,
  getConnectors,
  linkAccount,
  loginHref,
  loginOffered,
  pullAccountNow,
  type ConnectedAccount,
  type ConnectorsView,
  type LoginKind,
  type OwnInstagram,
  type SocialPlatform,
} from "@/lib/connectors";
import { Card, ErrorRow, ListRow, LoadingRow, RowMenu, Section, SettingsSelect, Status, saveFailed, InUse } from "./ui";
import { ApifyKeyRow } from "./ApiKeysSection";
import { PlatformLogo } from "./PlatformLogos";
import { msg } from "./helpers";
import type { SearchRowId } from "./search";

const SIGN_IN: Record<LoginKind, string> = { meta: "Sign in with Facebook", google: "Sign in with YouTube", tiktok: "Sign in with TikTok" };
const n = (v?: number) => (v === undefined ? "" : v >= 10_000 ? `${Math.round(v / 1000).toLocaleString("en-US")}k` : v.toLocaleString("en-US"));
/** "@name", whether the handle was stored with its @ or without. */
const NO_LOGINS: Record<LoginKind, boolean> = { meta: false, google: false, tiktok: false };
const at = (handle: string) => `@${handle.replace(/^@+/, "")}`;
const NOUN: Record<SocialPlatform, string> = { instagram: "an Instagram", facebook: "a Facebook", youtube: "a YouTube", tiktok: "a TikTok", x: "an X" };
const loginOf = (p: SocialPlatform): LoginKind | undefined => PLATFORMS.find((x) => x.id === p)?.login;

/** What a row says when the sign-in service was asked for its platform and does not offer it (or could not be reached). */
export const SIGN_IN_OFF = "Sign-in is not available right now";

/**
 * The sign-in items this server has its own app for (the login is the platform's own: Meta covers Facebook and
 * Instagram). `viaService`: the ones only the sign-in service could give are left out, since nothing here knows
 * whether they can finish (the service is asked only when a person presses Add on the Social accounts page).
 */
export function signInItems(logins: Record<LoginKind, boolean>, viaService: readonly LoginKind[] = []): Array<{ id: LoginKind; label: string }> {
  return LOGINS.filter((l) => logins[l.id] && !viaService.includes(l.id)).map((l) => ({ id: l.id, label: SIGN_IN[l.id] }));
}

/** One platform for one project: its account, or the one way this server can add one (its sign-in, a public @handle). */
export interface PlatformRow {
  platform: SocialPlatform;
  label: string;
  /** The account's @handle and numbers, or how an account is added on this server. */
  summary: string;
  /** "Add" opens the platform's dialog (or its handle field); none = an account is there. The Apify key a public @handle
   *  needs is never asked for on this page: the dialog sends the person to API keys, the one place it is entered. */
  button?: "Add";
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
export function platformRows(view: Pick<ConnectorsView, "logins" | "apify" | "accounts" | "instagram">, projectId?: string, off: LoginKind[] = []): PlatformRow[] {
  return PLATFORMS.flatMap((p): PlatformRow[] => {
    // off: the sign-in service was asked (Add was pressed) and does not offer this platform's sign-in
    const said = !!p.login && off.includes(p.login) ? `${SIGN_IN_OFF}. ` : "";
    const loginOn = !!p.login && !!view.logins[p.login] && !said;
    const on = view.accounts.filter((a) => a.platform === p.id);
    // ponytail: a Meta sign-in can bring several Pages into one project; the row shows the first
    const account = on.find((a) => !!projectId && a.projectId === projectId) ?? on.find((a) => !a.projectId);
    if (account) {
      const f = account.stats?.followers;
      return [{ platform: p.id, label: p.label, summary: [at(account.handle), f !== undefined ? `${n(f)} followers` : ""].filter(Boolean).join(" · "), account }];
    }
    if (p.id === "instagram") {
      const own = view.instagram.find((x) => !!projectId && x.projectId === projectId) ?? view.instagram.find((x) => x.mine && !x.projectId);
      if (own) return [{ platform: p.id, label: p.label, summary: [at(own.handle), own.followers !== undefined ? `${n(own.followers)} followers` : ""].filter(Boolean).join(" · "), own }];
      return [{ platform: p.id, label: p.label, summary: loginOn ? "Your account by sign-in, or by @handle" : `${said}Your account, by @handle`, button: "Add" }];
    }
    const own = p.id === "facebook" ? "Your Pages by sign-in" : p.id === "youtube" ? "Your channel by sign-in" : "Your account by sign-in";
    const summary = loginOn ? `${own}, or by @handle` : said + (p.id === "facebook" ? "Public Pages, by @handle" : p.id === "youtube" ? "Public channels, by @handle" : "Public accounts, by @handle");
    return [{ platform: p.id, label: p.label, summary, button: "Add" }];
  });
}

/**
 * Settings → Social accounts: the platforms the app reads for the project picked above them, one row each with the
 * project's account (its … menu) or one button. `back` = where a sign-in returns (the setup dialog passes its own step). `compact` = the
 * form behind a tool's "An Apify key" need (setup/ToolNeeds.tsx): the Apify key row, and a sign-in row only for a
 * platform this server has its own app for. A sign-in that would come from the sign-in service is not offered there:
 * that form cannot know it will finish, and a row that ends nowhere is worse than no row.
 */
export function ConnectorsSection({ back = "/settings/connectors", compact }: { sub?: string; back?: string; compact?: boolean }) {
  const projects = useWorkspace((s) => s.projects);
  const current = useWorkspace((s) => s.currentProjectId);
  const { data: view, error, refresh } = useCachedLoad<ConnectorsView>("/api/connectors", getConnectors, { own: true });
  const [dlg, setDlg] = useState<{ platform: SocialPlatform; step: "choose" | "handle"; seq: number }>({ platform: "tiktok", step: "handle", seq: 0 });
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  // The sign-in service is asked only when the person acts (Add, Sign in), never to draw the rows. `off`: the sign-ins it
  // then said it does not offer, said on their rows until the page is left; `asking`: the one being asked for now.
  const [off, setOff] = useState<LoginKind[]>([]);
  const [asking, setAsking] = useState<LoginKind | null>(null);
  const offered = async (kind: LoginKind, view: ConnectorsView): Promise<boolean> => {
    if (!view.logins[kind]) return false;
    // this server's own app: nothing to ask
    if (!view.viaService?.includes(kind)) return true;
    setAsking(kind);
    const on = await loginOffered(kind).catch(() => false);
    setAsking(null);
    setOff((was) => (on ? was.filter((k) => k !== kind) : [...new Set([...was, kind])]));
    return on;
  };

  const reload = useCallback(() => refresh().catch(() => {}), [refresh]);
  // a sign-in from the Mac app finishes in the computer's browser: coming back to the window shows the new account
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
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
        {signInItems(view?.logins ?? NO_LOGINS, view?.viaService).map((l) => (
          <ListRow
            key={l.id}
            title={l.label}
            subtitle={LOGINS.find((x) => x.id === l.id)!.gives}
            actions={
              <Button asChild size="sm" variant="outline">
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
        <Card>{error ? <ErrorRow title="Couldn't load your accounts" detail={error} retry={() => void reload()} /> : <LoadingRow />}</Card>
      </Section>
    );
  }

  const rows = platformRows(view, current ?? undefined, off);
  const choose = async (platform: SocialPlatform) => {
    const login = loginOf(platform);
    const loginOn = !!login && (await offered(login, view));
    setDlg((d) => ({ platform, step: loginOn ? "choose" : "handle", seq: d.seq + 1 }));
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
                  <>
                  <InUse>Connected</InUse>
                  <RowMenu
                    label={`${at(r.own.handle)} actions`}
                    items={[
                      // not "my account" any more: the Analyzer keeps it as a followed account, no project links it
                      { label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${at(r.own.handle)}?`, body: "Its numbers stop updating here.", ok: "Disconnect" }, onSelect: () => void act(patchInstagram(r.own!.id, { mine: false })) },
                    ]}
                  />
                  </>
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
              />
            ) : (
              <ListRow
                key={r.platform}
                id={`platform-${r.platform}` as SearchRowId}
                icon={<PlatformLogo platform={r.platform} className="size-4" />}
                title={r.label}
                subtitle={r.summary}
                actions={
                  r.button && (
                    <Button size="sm" variant="outline" aria-label={`${r.button} ${r.label}`} disabled={!!asking && asking === loginOf(r.platform)} onClick={() => void choose(r.platform)}>
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
/** Meta lets an app read an Instagram account only when it is a professional one (Business or Creator) linked to a Page. */
const IG_NEEDS = "Needs a Business or Creator account linked to a Facebook Page you manage.";

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
  const ytKey = platform === "youtube" && !!view.youtubeKey;
  const configured = ig || ytKey || (view.apify.configured && view.apify.valid !== false);
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
                  <span className="text-xs text-muted-foreground">{ig ? IG_NEEDS : `${LOGINS.find((l) => l.id === login)!.gives.replace(/^./, (c) => c.toUpperCase())}.`}</span>
                </a>
              )}
              {platform === "instagram" ? (
                <button type="button" className={choiceCls} onClick={() => setStep("handle")}>
                  <span className="text-sm font-medium">My own account, by @handle</span>
                </button>
              ) : (
                <button type="button" className={choiceCls} onClick={() => setStep("handle")}>
                  <span className="text-sm font-medium">Someone's public account</span>
                  <span className="text-xs text-muted-foreground">{ytKey ? "Type its @handle." : configured ? "Type its @handle. Reads its public posts with your Apify key." : "Needs your Apify key first."}</span>
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
                {ig ? "Type your @handle or profile link." : ytKey ? "Type its @handle or channel link." : configured ? "Type its @handle or profile link. Reads its public posts with your Apify key." : "Reading public posts needs your Apify key. Add it first."}
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
function AccountRow({ row, a, back, onLink, onPull, onRemove }: {
  row: PlatformRow;
  a: ConnectedAccount;
  back: string;
  onLink: () => void;
  onPull: () => void;
  onRemove: () => Promise<unknown>;
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
          {!status && <InUse>Connected</InUse>}
          {needsSignIn && login && (
            <Button asChild size="sm" variant="outline">
              <a href={loginHref(login, { back })}>Sign in again</a>
            </Button>
          )}
          <RowMenu
            label={`${at(a.handle)} actions`}
            items={[
              { label: "Read again", icon: <RefreshCw />, onSelect: onPull },
              // an account linked to no project shows in each one: this keeps it in the one picked
              ...(!a.projectId ? [{ label: "Link to this project", onSelect: onLink }] : []),
              { label: "Disconnect", destructive: true, confirm: { title: `Disconnect ${at(a.handle)}?`, body: "Its numbers stop updating here.", ok: "Disconnect" }, onSelect: () => void onRemove() },
            ]}
          />
        </>
      }
    />
  );
}
