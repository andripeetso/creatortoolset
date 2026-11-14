import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { patchAccount as patchInstagram } from "@/lib/instagram";
import { useCachedLoad } from "@/lib/local-cache";
import { useWorkspace } from "@/lib/workspace";
import {
  LOGINS,
  PLATFORMS,
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
const loginOf = (p: SocialPlatform): LoginKind | undefined => PLATFORMS.find((x) => x.id === p)?.login;

/** The time of the newest platform sign-in in the list (the server's clock), 0 with none. */
export const newestSignIn = (accounts: readonly ConnectedAccount[]) => Math.max(0, ...accounts.filter((a) => a.via === "login").map((a) => a.connectedAt));
/** The accounts a platform sign-in connected after `since` (a time from newestSignIn, so one clock is compared with itself). */
export const signedInSince = (accounts: readonly ConnectedAccount[], since: number) => accounts.filter((a) => a.via === "login" && a.connectedAt > since);

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

/** Meta lets an app read an Instagram account only when it is a professional one (Business or Creator) linked to a Page. */
const IG_NEEDS = "A Business or Creator account linked to a Facebook Page";

/** One platform for one project: its account, or its sign-in on this server. */
export interface PlatformRow {
  platform: SocialPlatform;
  label: string;
  /** The account's @handle and numbers, or how an account is added on this server. */
  summary: string;
  /** "Add" starts the platform's sign-in; none = an account is there (or the sign-in is not available). */
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
    const said = !!p.login && off.includes(p.login);
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
    }
    // only accounts the person signs in to: a platform without a sign-in here has no row (a public account is followed
    // where it is read, not here); one the sign-in service turned down says so, with nothing to press
    if (said) return [{ platform: p.id, label: p.label, summary: SIGN_IN_OFF }];
    if (!loginOn) return [];
    const summary = p.id === "instagram" ? IG_NEEDS : p.id === "facebook" ? "Your Pages" : p.id === "youtube" ? "Your channel" : "Your account";
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
export function ConnectorsSection({ back = "/settings/connectors", compact, projectId: pinned }: {
  sub?: string;
  back?: string;
  compact?: boolean;
  /** One project's accounts (the project form): no project picker, and a platform with nothing to add has no row. */
  projectId?: string;
}) {
  const projects = useWorkspace((s) => s.projects);
  const picked = useWorkspace((s) => s.currentProjectId);
  const current = pinned ?? picked;
  const { data: view, error, refresh } = useCachedLoad<ConnectorsView>("/api/connectors", getConnectors, { own: true });
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
  // A sign-in started with Add finishes somewhere else: the Mac app sends it to the computer's browser. The server tells
  // this window when the account is saved (it announces "connectors") and the list reads itself again. `waiting`: the
  // newest sign-in there was when Add was pressed.
  const waiting = useRef<number | null>(null);
  useEffect(() => {
    if (!view || waiting.current === null) return;
    const fresh = signedInSince(view.accounts, waiting.current);
    if (!fresh.length) return;
    waiting.current = null;
    toast(`${fresh.map((a) => at(a.handle)).join(", ")} connected. Reading ${fresh.length > 1 ? "their" : "its"} numbers now.`);
  }, [view]);
  // a sign-in from the Mac app finishes in the computer's browser: coming back to the window shows the new account
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  // a pull runs on the server: look again a few times
  const watch = () => [4, 10, 25, 60].forEach((s) => window.setTimeout(() => void reload(), s * 1000));
  const act = (p: Promise<unknown>) => p.then(reload).catch((e) => saveFailed(msg(e)));
  const projectId = () => pinned ?? useWorkspace.getState().currentProjectId ?? undefined;

  // the sign-in comes back here with the result: say it once, then drop it from the address
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("error");
    if (!connected && !failed) return;
    if (failed) saveFailed(failed);
    else {
      toast(`${connected === "1" ? "Account" : `${connected} accounts`} connected. Reading the numbers now.`);
      watch();
    }
    setParams((p) => (p.delete("connected"), p.delete("error"), p), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // `?add=<platform>` starts that platform's sign-in once, where its row has Add, then the parameter goes. A link is not
  // the person's press, so it never asks the sign-in service: a platform whose sign-in comes from there is left alone.
  useEffect(() => {
    const add = params.get("add");
    if (!add || compact || !view) return;
    const row = platformRows(view, current ?? undefined, off).find((r) => r.platform === add && r.button);
    const login = row && loginOf(row.platform);
    if (row && !(login && view.logins[login] && view.viaService?.includes(login))) void choose(row.platform);
    setParams((p) => (p.delete("add"), p), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `choose` is below the two returns this effect also stops at
  }, [params, view]);

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
    if (pinned && !error) return null;
    return (
      <Section title="Platforms">
        <Card>{error ? <ErrorRow title="Couldn't load your accounts" detail={error} retry={() => void reload()} /> : <LoadingRow />}</Card>
      </Section>
    );
  }

  const rows = platformRows(view, current ?? undefined, off);
  if (pinned && !rows.length) return null;
  // Add is the platform's sign-in itself (the Mac app finishes it in the computer's browser)
  const choose = async (platform: SocialPlatform) => {
    const login = loginOf(platform);
    if (!login || !(await offered(login, view))) return;
    waiting.current = newestSignIn(view.accounts);
    window.location.assign(loginHref(login, { back, projectId: projectId() }));
  };

  const card = (
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
  );
  // in the project form the rows stand under its own "Accounts"
  if (pinned) return card;
  return (
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
      {card}
    </Section>
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
