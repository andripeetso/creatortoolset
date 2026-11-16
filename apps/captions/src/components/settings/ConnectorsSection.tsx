import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth";
import { patchAccount as patchInstagram } from "@/lib/instagram";
import { useCachedLoad } from "@/lib/local-cache";
import { patchProject } from "@/lib/workshop";
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
import { Card, ErrorRow, ListRow, LoadingRow, RowMenu, Section, Status, WorkspacePick, WorkspaceTag, moveItems, saveFailed, useSettingsWorkspace, InUse, type RowMenuItem } from "./ui";
import { ApifyKeyRow } from "./ApiKeysSection";
import { PlatformLogo } from "./PlatformLogos";
import { msg } from "./helpers";
import type { SearchRowId } from "./search";

const n = (v?: number) => (v === undefined ? "" : v >= 10_000 ? `${Math.round(v / 1000).toLocaleString("en-US")}k` : v.toLocaleString("en-US"));
const NO_LOGINS: Record<LoginKind, boolean> = { meta: false, google: false, tiktok: false };
/** "@name", whether the handle was stored with its @ or without. */
const at = (handle: string) => `@${handle.replace(/^@+/, "")}`;
const loginOf = (p: SocialPlatform): LoginKind | undefined => PLATFORMS.find((x) => x.id === p)?.login;

/** The time of the newest platform sign-in in the list (the server's clock), 0 with none. */
export const newestSignIn = (accounts: readonly ConnectedAccount[]) => Math.max(0, ...accounts.filter((a) => a.via === "login").map((a) => a.connectedAt));
/** The accounts a platform sign-in connected after `since` (a time from newestSignIn, so one clock is compared with itself). */
export const signedInSince = (accounts: readonly ConnectedAccount[], since: number) => accounts.filter((a) => a.via === "login" && a.connectedAt > since);

/** What a row says when the sign-in service was asked for its platform and does not offer it (or could not be reached). */
export const SIGN_IN_OFF = "Sign-in not available";

/**
 * The sign-ins this server has its own app for, by the platforms each covers (the login is the platform's own: Meta
 * covers Facebook and Instagram). `viaService`: the ones only the sign-in service could give are left out, since nothing
 * here knows whether they can finish (the service is asked only when a person presses Add on the Social accounts page).
 */
export function signInItems(logins: Record<LoginKind, boolean>, viaService: readonly LoginKind[] = []): Array<{ id: LoginKind; label: string }> {
  return LOGINS.filter((l) => logins[l.id] && !viaService.includes(l.id)).map((l) => ({ id: l.id, label: l.label }));
}

/** Meta lets an app read an Instagram account only when it is a professional one (Business or Creator) linked to a Page. */
const IG_NEEDS = "A Business or Creator account linked to a Facebook Page";

/** One row of the list: a platform's account, or the platform's sign-in on this server. */
export interface PlatformRow {
  platform: SocialPlatform;
  label: string;
  /** The account's @handle and numbers, or what adding one needs on this platform ("" = nothing to say). */
  summary: string;
  /** "Add" starts the platform's sign-in; none = an account is there (or the sign-in is not available). */
  button?: "Add";
  /** An account the person connected (its workspace is its `projectId`; none = every workspace). */
  account?: ConnectedAccount;
  /** Instagram: the person's own account in the Analyzer, when no sign-in account is there (its workspace is the one that links it). */
  own?: OwnInstagram;
}

type Platform = (typeof PLATFORMS)[number];
const summaryOf = (handle: string, followers?: number) => [at(handle), followers !== undefined ? `${n(followers)} followers` : ""].filter(Boolean).join(" · ");
const accountRow = (p: Platform, account: ConnectedAccount): PlatformRow => ({ platform: p.id, label: p.label, summary: summaryOf(account.handle, account.stats?.followers), account });
const ownRow = (p: Platform, own: OwnInstagram): PlatformRow => ({ platform: p.id, label: p.label, summary: summaryOf(own.handle, own.followers), own });
/**
 * A platform with no account. Only accounts the person signs in to: a platform without a sign-in here has no row (a
 * public account is followed where it is read, not here); one the sign-in service turned down (`off`: asked when Add was
 * pressed) says so, with nothing to press.
 */
function addRow(p: Platform, logins: ConnectorsView["logins"], off: readonly LoginKind[]): PlatformRow[] {
  if (p.login && off.includes(p.login)) return [{ platform: p.id, label: p.label, summary: SIGN_IN_OFF }];
  if (!p.login || !logins[p.login]) return [];
  return [{ platform: p.id, label: p.label, summary: p.id === "instagram" ? IG_NEEDS : "", button: "Add" }];
}

type RowsView = Pick<ConnectorsView, "logins" | "apify" | "accounts" | "instagram">;

/**
 * Social accounts for one workspace: one row per platform, in the order of PLATFORMS, each with the workspace's one
 * account or its Add button. An account in no workspace shows in every workspace until one is added there. Instagram is
 * the person's own account: its sign-in, else the Analyzer account the workspace links (or the one marked Mine that no
 * workspace links).
 */
export function platformRows(view: RowsView, projectId?: string, off: LoginKind[] = []): PlatformRow[] {
  return PLATFORMS.flatMap((p): PlatformRow[] => {
    const on = view.accounts.filter((a) => a.platform === p.id);
    // ponytail: a Meta sign-in can bring several Pages into one workspace; the row shows the first (All workspaces lists each)
    const account = on.find((a) => !!projectId && a.projectId === projectId) ?? on.find((a) => !a.projectId);
    if (account) return [accountRow(p, account)];
    if (p.id === "instagram") {
      const own = view.instagram.find((x) => !!projectId && x.projectId === projectId) ?? view.instagram.find((x) => x.mine && !x.projectId);
      if (own) return [ownRow(p, own)];
    }
    return addRow(p, view.logins, off);
  });
}

/**
 * Social accounts for all workspaces: every account the person has, in the order of PLATFORMS, and the Add button of a
 * platform with none. An Instagram account in the Analyzer that a sign-in account fills is that account's one row.
 */
export function everyRow(view: RowsView, off: LoginKind[] = []): PlatformRow[] {
  return PLATFORMS.flatMap((p): PlatformRow[] => {
    const accounts = view.accounts.filter((a) => a.platform === p.id);
    const filled = new Set(accounts.map((a) => a.analyzerId));
    const own = p.id === "instagram" ? view.instagram.filter((x) => !filled.has(x.id)) : [];
    const rows = [...accounts.map((a) => accountRow(p, a)), ...own.map((x) => ownRow(p, x))];
    return rows.length ? rows : addRow(p, view.logins, off);
  });
}

/**
 * Settings → Social accounts (the Workspace group): the accounts the app reads, one row each with its … menu, and one Add
 * button per platform with none. All workspaces: every account, each with its workspace; one workspace: its accounts and
 * the ones in every workspace. `projectId` pins it to one workspace (the workspace form, a new workspace's accounts
 * step): the card alone. `back` = where a sign-in returns. `compact` = the form behind a tool's "An Apify key" need
 * (setup/ToolNeeds.tsx): the Apify key row, and a sign-in row only for a platform this server has its own app for. A
 * sign-in that would come from the sign-in service is not offered there: that form cannot know it will finish, and a row
 * that ends nowhere is worse than no row.
 */
export function ConnectorsSection({ back = "/settings/connectors", compact, projectId: pinned, title }: {
  sub?: string;
  back?: string;
  compact?: boolean;
  /** One workspace's accounts (the workspace form): no selector, and a platform with nothing to add has no row. */
  projectId?: string;
  /** With `projectId`: the heading over the card, drawn only while there is a row under it. */
  title?: string;
}) {
  const w = useSettingsWorkspace("list");
  const me = useMe()?.username;
  const all = !pinned && w.all;
  const current = pinned ?? w.id;
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
    toast(`${fresh.map((a) => at(a.handle)).join(", ")} connected`);
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
  // the workspace a new account goes to: the pinned or picked one; from All workspaces, the window's
  const projectId = () => current ?? useWorkspace.getState().currentProjectId ?? undefined;
  const rowsOf = (view: ConnectorsView) => (all ? everyRow(view, off) : platformRows(view, current ?? undefined, off));

  // the sign-in comes back here with the result: say it once, then drop it from the address
  useEffect(() => {
    const connected = params.get("connected");
    const failed = params.get("error");
    if (!connected && !failed) return;
    if (failed) saveFailed(failed);
    else {
      toast(connected === "1" ? "Account connected" : `${connected} accounts connected`);
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
    const row = rowsOf(view).find((r) => r.platform === add && r.button);
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
      <>
        <WorkspacePick mode="list" />
        <Section title="Social accounts">
          <Card>{error ? <ErrorRow title="Could not load social accounts" detail={error} retry={() => void reload()} /> : <LoadingRow />}</Card>
        </Section>
      </>
    );
  }

  const rows = rowsOf(view);
  if (pinned && !rows.length) return null;
  // Add is the platform's sign-in itself (the Mac app finishes it in the computer's browser)
  const choose = async (platform: SocialPlatform) => {
    const login = loginOf(platform);
    if (!login || !(await offered(login, view))) return;
    waiting.current = newestSignIn(view.accounts);
    window.location.assign(loginHref(login, { back, projectId: projectId() }));
  };

  // A row menu's moves. With one workspace an account in none can still be put in it (the Workshop gets a linked account's numbers).
  const only = w.workspaces.length === 1 ? w.workspaces[0] : undefined;
  const moves = (a: ConnectedAccount): RowMenuItem[] => {
    const move = (to: string | null) => act(linkAccount(a.key, to));
    return only && !a.projectId ? [{ label: `Move to ${only.name}`, onSelect: () => move(only.id) }] : moveItems(w.workspaces, a.projectId, move);
  };
  // Instagram's link is on the workspace record (its accountId), one account a workspace: it moves to a workspace of the
  // person's own with none, and with no workspace it is shown only while it is the one marked Mine
  const moveOwn = async (own: OwnInstagram, to: string | null) => {
    if (to) await patchProject(to, { accountId: own.id });
    if (own.projectId) await patchProject(own.projectId, { accountId: null });
  };
  const ownMoves = (own: OwnInstagram): RowMenuItem[] => [
    ...w.workspaces.filter((p) => p.owner === me && !p.accountId).map((p) => ({ label: `Move to ${p.name}`, onSelect: () => act(moveOwn(own, p.id)) })),
    ...(own.projectId && own.mine ? [{ label: "Use in every workspace", onSelect: () => act(moveOwn(own, null)) }] : []),
  ];
  // an account is the person's, not one workspace's: Disconnect takes it out of them all
  const disconnect = (handle: string, onSelect: () => unknown): RowMenuItem => ({
    label: "Disconnect",
    destructive: true,
    confirm: { title: `Disconnect ${at(handle)}?`, body: w.many ? "The account is removed from every workspace." : undefined, ok: "Disconnect" },
    onSelect,
  });

  const card = (
    <Card>
      {rows.map((r) =>
        r.own ? (
          <ListRow
            key={r.own.id}
            id={`platform-${r.platform}` as SearchRowId}
            icon={<PlatformLogo platform={r.platform} className="size-4" />}
            title={r.label}
            subtitle={r.summary}
            status={all && <WorkspaceTag id={r.own.projectId} />}
            actions={
              <>
                <InUse>Connected</InUse>
                {/* not the person's own account after it: the Analyzer keeps it as a followed account, no workspace links it */}
                <RowMenu label={`${at(r.own.handle)} actions`} items={[...ownMoves(r.own), disconnect(r.own.handle, () => void act(patchInstagram(r.own!.id, { mine: false })))]} />
              </>
            }
          />
        ) : r.account ? (
          <AccountRow
            key={r.account.key}
            row={r}
            a={r.account}
            back={back}
            tag={all}
            items={[{ label: "Read again", icon: <RefreshCw />, onSelect: () => void act(pullAccountNow(r.account!.key).then(watch)) }, ...moves(r.account), disconnect(r.account.handle, () => void act(disconnectAccount(r.account!.key)))]}
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
  if (pinned) return title ? <Section title={title}>{card}</Section> : card;
  return (
    <>
      <WorkspacePick mode="list" />
      <Section id="social-platforms" title="Social accounts">
        {card}
      </Section>
    </>
  );
}

/** A row with an account: its numbers, its workspace (All workspaces), a sign-in that ran out, and its … menu. */
function AccountRow({ row, a, back, tag, items }: { row: PlatformRow; a: ConnectedAccount; back: string; tag: boolean; items: RowMenuItem[] }) {
  const login = loginOf(a.platform);
  const needsSignIn = a.loginStatus === "needs_reconnect";
  const status: ReactNode = needsSignIn ? <Status tone="attention">Needs sign-in</Status> : a.pullError ? <Status tone="broken">{a.pullError}</Status> : undefined;
  return (
    <ListRow
      id={`platform-${a.platform}` as SearchRowId}
      icon={<PlatformLogo platform={a.platform} className="size-4" />}
      title={row.label}
      subtitle={row.summary}
      status={
        (tag || status) && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {tag && <WorkspaceTag id={a.projectId} />}
            {status}
          </span>
        )
      }
      actions={
        <>
          {!status && <InUse>Connected</InUse>}
          {needsSignIn && login && (
            <Button asChild size="sm" variant="outline">
              <a href={loginHref(login, { back })}>Sign in again</a>
            </Button>
          )}
          <RowMenu label={`${at(a.handle)} actions`} items={items} />
        </>
      }
    />
  );
}
