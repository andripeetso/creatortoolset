import { SettingsDialog, SettingsDialogContent } from "./kit-dialog";
import { Check, Eye, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import type { AiRoute, InvitePatch, MemberPatch, MemberView, WorkspaceView } from "@contracts/workspaces";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { useMe } from "@/lib/auth";
import { webPlugins } from "@/plugins.gen";
import { useCachedLoad } from "@/lib/local-cache";
import { createInvite, getWorkspace, inviteUrl, offAfterToggle, removeMember, renameWorkspace, revokeInvite, setSignInWith, updateInvite, updateMember } from "@/lib/workspaces";
import { AskEveryone, Tick, useServerAccounts } from "@/components/AdminPanel";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, TextField, saveFailed } from "./ui";
import { useSignInApps } from "./AccountSection";
import { lastActiveText, msg } from "./helpers";

type SignInProvider = "google" | "apple" | "github";
const PROVIDERS: SignInProvider[] = ["google", "apple", "github"];
const PROVIDER_NAME: Record<SignInProvider, string> = { google: "Google", apple: "Apple", github: "GitHub" };
const orList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? ""));

/**
 * The team's sign-in methods (api/auth.ts ruleFor enforces it): a password too, each sign-in the server has switched on
 * alone, and all the switched-on ones together. Each option names what it lets in. `saved` is what the team has now; a
 * sign-in that is switched off here stays as the last choice so the value shown is the one that is enforced.
 */
export function signInOptions(on: readonly SignInProvider[], saved: readonly string[] = []): { id: string; label: string; value: SignInProvider[] }[] {
  const opts: { id: string; label: string; value: SignInProvider[] }[] = [{ id: "any", label: orList(["Password", ...on.map((p) => PROVIDER_NAME[p])]), value: [] }];
  for (const p of on) opts.push({ id: p, label: `${PROVIDER_NAME[p]} only`, value: [p] });
  if (on.length > 1) opts.push({ id: "all", label: orList(on.map((p) => PROVIDER_NAME[p])), value: [...on] });
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const kept = saved.filter((x): x is SignInProvider => (PROVIDERS as string[]).includes(x));
  if (kept.length && !opts.some((o) => same(o.value, kept))) opts.push({ id: "saved", label: orList(kept.map((p) => PROVIDER_NAME[p])), value: kept });
  return opts;
}
export const signInId = (opts: ReturnType<typeof signInOptions>, saved: readonly string[] | undefined) =>
  opts.find((o) => o.value.length === (saved ?? []).length && o.value.every((x) => (saved ?? []).includes(x)))?.id ?? "any";

type Brand = { id: string; name: string };
/** A team that was never named is stored as "Team" (or, before that, "Workspace"): shown as no name. */
const teamName = (name: string) => (name === "Workspace" || name === "Team" ? "" : name);

/**
 * Settings → Team (hosted servers only). Membership is per server, so the page has no workspace selector. The owner
 * names the team, sets its sign-in methods, invites people and removes them; which of the owner's workspaces a person
 * works in is their row's "Workspaces…". A member sees their own row. Access is one grid of everyone in the team and
 * everyone invited: the apps each may open (the account's `off` and `read`) and whether they read the owner's scripts;
 * an invite's row is what that person gets once they join (api/workspace.ts PATCH /invites/:id). A platform admin also
 * runs every account on the server, in one place: Accounts (New account and each account's menu; api/admin.ts), and the
 * sign-in code for everyone.
 */
export function WorkspaceSection() {
  const me = useMe();
  // "not in a team" is an answer too (team: null), kept apart from "not known yet"
  const saved = useCachedLoad<{ team: WorkspaceView | null }>("/api/workspace", () => getWorkspace().then((team) => ({ team })), { own: true });
  const view: WorkspaceView | null | undefined = saved.data ? saved.data.team : undefined;
  const failed = !saved.data && !!saved.error;
  const [inviting, setInviting] = useState(false);
  const [params, setParams] = useSearchParams();
  // `?add=1` opens Invite once for the team's owner, then the parameter goes
  useEffect(() => {
    if (params.get("add") !== "1" || view === undefined) return;
    if (view?.me === "owner") setInviting(true);
    setParams((p) => (p.delete("add"), p), { replace: true });
  }, [params, setParams, view]);
  const [aiFor, setAiFor] = useState<MemberView | null>(null);
  const [spacesFor, setSpacesFor] = useState<{ who: string; given: string[]; save: (ids: string[]) => Promise<unknown> } | null>(null);
  // the sign-ins this server has switched on (the Account page's list): the team can only be set to these
  const apps = useSignInApps();
  const on: SignInProvider[] | null = apps ? PROVIDERS.filter((p) => apps[p]) : null;

  const refresh = saved.refresh;
  const load = useCallback(() => refresh().catch(() => {}), [refresh]);
  // a platform admin also runs the server's accounts here: passwords, locks, admin or not, delete
  const admin = me?.role === "admin";
  const accounts = useServerAccounts(admin, () => void load());

  if (failed) {
    return (
      <Section title="Team">
        <Card>
          <ErrorRow title="Could not load the team" retry={() => void load()} />
        </Card>
      </Section>
    );
  }
  if (view === undefined) {
    return (
      <Section title="Team">
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );
  }
  if (view === null) {
    return (
      <Section title="Team">
        <Card>
          <EmptyRow title="No team" />
        </Card>
      </Section>
    );
  }

  const owner = view.me === "owner";
  if (!owner) {
    // a member can change nothing here: their own line, with the team's name, is the only row
    const mine = view.members.find((m) => m.username === me?.username);
    return (
      <Section title="Team">
        <Card>
          <ListRow title={me?.username ?? ""} subtitle={[teamName(view.workspace.name), mine ? memberLine(mine, true, false) : ""].filter(Boolean).join(" · ") || undefined} />
        </Card>
      </Section>
    );
  }
  // every change reloads the view; a failure throws, so the control that asked shows its toast
  const act = (p: Promise<unknown>) => p.then(load);
  const attempt = (p: Promise<unknown>) => act(p).catch((e) => saveFailed(msg(e)));
  const brands: Brand[] = view.brands ?? [];
  /** A row menu's "Workspaces…": only when the owner has workspaces to give. */
  const spacesItem = (who: string, given: string[] | undefined, save: (ids: string[]) => Promise<unknown>) =>
    brands.length ? [{ label: "Workspaces…", onSelect: () => setSpacesFor({ who, given: given ?? [], save }) }] : [];

  return (
    <>
      <Section title="Team">
        <Card>
          <Row
            id="team-name"
            title="Team name"
            control={
              <TextField
                label="Team name"
                value={teamName(view.workspace.name)}
                onCommit={async (next) => {
                  if (!next.trim()) throw new Error("Enter a team name.");
                  await act(renameWorkspace(next.trim()));
                }}
              />
            }
          />
          {/* only when the server has a sign-in to require: with none there is nothing to choose, so no row */}
          {on !== null && on.length > 0 && (
            <Row
              id="team-sign-in"
              title="Sign-in methods"
              control={
                (
                  <SettingsSelect
                    label="Sign-in methods"
                    value={signInId(signInOptions(on, view.workspace.signInWith), view.workspace.signInWith)}
                    options={signInOptions(on, view.workspace.signInWith).map((o) => ({ value: o.id, label: o.label }))}
                    onValueChange={(id) =>
                      void attempt(setSignInWith(signInOptions(on, view.workspace.signInWith).find((o) => o.id === id)?.value ?? []))
                    }
                  />
                )
              }
            />
          )}
        </Card>
      </Section>

      {admin && <AskEveryone />}

      <Section
        id="team-members"
        title="Members"
        action={
          <Button size="xs" variant="ghost" onClick={() => setInviting(true)}>
            <Plus className="size-3" /> Invite
          </Button>
        }
      >
        <Card>
          {view.members.map((m) => {
            const self = m.username === me?.username;
            return (
              <ListRow
                key={m.username}
                title={
                  <>
                    {m.name || m.username}
                    {m.name && <span className="ml-1.5 font-normal text-muted-foreground">{m.username}</span>}
                    {self && <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>}
                  </>
                }
                subtitle={[memberLine(m, self, true), worksIn(brands, m.workspaces)].filter(Boolean).join(" · ")}
                actions={
                  m.role !== "owner" && !self ? (
                    <RowMenu
                      label={`More for ${m.username}`}
                      items={[
                        { label: "AI…", onSelect: () => setAiFor(m) },
                        ...spacesItem(m.username, m.workspaces, (workspaces) => act(updateMember(m.username, { workspaces }))),
                        { label: "Remove from team", destructive: true, confirm: { title: `Remove ${m.username} from the team?`, ok: "Remove" }, onSelect: () => act(removeMember(m.username)) },
                      ]}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </Card>
      </Section>

      {view.invites.length > 0 && (
        <Section id="team-invite" title="Pending invites">
          <Card>
            {view.invites.map((i) => (
              <ListRow
                key={i.id}
                title={i.email ?? "Invite link"}
                subtitle={[`Expires ${new Date(i.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, worksIn(brands, i.workspaces)].filter(Boolean).join(" · ")}
                actions={
                  <RowMenu
                    label={`More for ${i.email ?? "this invite"}`}
                    items={[
                      ...spacesItem(i.email ?? "this invite", i.workspaces, (workspaces) => act(updateInvite(i.id, { workspaces }))),
                      { label: "Delete", destructive: true, confirm: { title: "Delete this invite?", body: "Nobody can join with it after this." }, onSelect: () => act(revokeInvite(i.id)) },
                    ]}
                  />
                }
              />
            ))}
          </Card>
        </Section>
      )}

      {(view.members.some((m) => m.role !== "owner") || view.invites.length > 0) && (
        <Section id="team-access" title="Access">
          <AccessGrid
            gates={admin ? webPlugins.flatMap((p) => p.gates ?? []) : []}
            rows={[
              ...view.members
                .filter((m) => m.role !== "owner")
                .map((m) => ({ key: m.username, label: m.name || m.username, off: m.off, read: m.read ?? [], scripts: !!m.scripts, save: (p: AccessPatch) => act(updateMember(m.username, p as MemberPatch)) })),
              ...view.invites.map((i) => ({
                key: i.id,
                label: (
                  <>
                    {i.email ?? "Invite link"} <span className="font-normal text-muted-foreground">invited</span>
                  </>
                ),
                off: i.off ?? [],
                read: i.read ?? [],
                scripts: !!i.scripts,
                save: (p: AccessPatch) => act(updateInvite(i.id, p as InvitePatch)),
              })),
            ]}
          />
        </Section>
      )}

      {webPlugins.map((p) => {
        const Access = p.access;
        const people = view.members.filter((m) => m.role !== "owner").map((m) => ({ username: m.username, label: m.name || m.username }));
        return Access && people.length > 0 ? <Access key={p.id} people={people} /> : null;
      })}

      {/* every account on the server, in the team or not: the one place an account is made, changed or deleted */}
      {admin && (
        <Section
          id="team-accounts"
          title="Accounts"
          action={
            <Button size="xs" variant="ghost" onClick={accounts.create}>
              <Plus className="size-3" /> New account
            </Button>
          }
        >
          <Card>
            {accounts.failed && <ErrorRow title="Could not load accounts" retry={accounts.retry} />}
            {!accounts.users && !accounts.failed && <LoadingRow />}
            {accounts.users?.map((u) => (
              <ListRow
                key={u.username}
                title={u.name || u.username}
                subtitle={accounts.lineOf(u)}
                // an admin's own account is changed on their Account page, as before
                actions={u.username === me?.username ? undefined : <RowMenu label={`More for ${u.username}`} items={accounts.menuItems(u)} />}
              />
            ))}
          </Card>
        </Section>
      )}

      {accounts.dialogs}
      <InviteDialog open={inviting} mail={Boolean(view.mail)} brands={brands} onOpenChange={setInviting} onCreated={() => void load()} />
      {aiFor && <AiDialog member={aiFor} onClose={() => setAiFor(null)} onSave={(m, patch) => act(updateMember(m.username, patch))} />}
      {spacesFor && <WorkspacesDialog who={spacesFor.who} brands={brands} given={spacesFor.given} onClose={() => setSpacesFor(null)} onSave={spacesFor.save} />}
    </>
  );
}

/** One line for a member: the role, and for the owner (and the person themselves) how their AI is paid. */
export function memberLine(m: MemberView, self: boolean, owner: boolean): string {
  const parts = [m.role === "owner" ? "Owner" : null];
  if (owner || self) {
    parts.push(m.ai === "own" ? "Own AI provider" : `Team budget $${m.spentUsd.toFixed(2)} of $${m.budgetUsd} this month`);
    parts.push(lastActiveText(m.lastActiveAt));
  }
  return parts.filter(Boolean).join(" · ");
}

/** The owner's workspaces a person works in, for their row: the one's name, or how many. Nothing for none. */
export function worksIn(brands: Brand[], given: string[] = []): string | null {
  const picked = brands.filter((b) => given.includes(b.id));
  return picked.length === 0 ? null : picked.length === 1 ? picked[0]!.name : `${picked.length} workspaces`;
}

/** A member's AI, as the owner picks it (api/lib/workspaces.ts updateMember: `ai` and, for a budget, `budgetUsd`). */
const AI_CHOICES: { id: AiRoute; label: string }[] = [
  { id: "own", label: "Own AI provider" },
  { id: "budget", label: "Team budget" },
];

/** The budget a person typed: dollars, $1 to $10,000 a month (the server keeps it to cents and the same range). */
export function budgetFrom(text: string): { ok: true; usd: number } | { ok: false; error: string } {
  const n = Number(text.replace(/[$,\s]/g, ""));
  if (!text.trim() || !Number.isFinite(n) || n < 1 || n > 10_000) return { ok: false, error: "Enter a budget from $1 to $10,000 a month." };
  return { ok: true, usd: Math.round(n * 100) / 100 };
}

/** A member's AI: their own provider, or a monthly budget on the server's key. Saved with the button; a failed save is a toast. */
function AiDialog({ member, onClose, onSave }: { member: MemberView; onClose: () => void; onSave: (m: MemberView, patch: MemberPatch) => Promise<unknown> }) {
  const [mode, setMode] = useState<AiRoute>(member.ai);
  const [amount, setAmount] = useState(member.budgetUsd ? String(member.budgetUsd) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let patch: MemberPatch = { ai: "own" };
    if (mode === "budget") {
      const b = budgetFrom(amount);
      if (!b.ok) {
        setError(b.error);
        return;
      }
      patch = { ai: "budget", budgetUsd: b.usd };
    }
    setError(null);
    setBusy(true);
    try {
      await onSave(member, patch);
      onClose();
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`AI for ${member.username}`} submitLabel="Save" onSubmit={submit} busy={busy} error={error}>
      <SettingsSelect label="AI" value={mode} onValueChange={(v) => setMode(v as AiRoute)} options={AI_CHOICES.map((o) => ({ value: o.id, label: o.label }))} className="sm:w-full" />
      {mode === "budget" && (
        <div className="space-y-1.5">
          <label htmlFor="team-budget" className="text-xs text-muted-foreground">
            Monthly budget in dollars
          </label>
          <Input id="team-budget" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="h-8 text-sm" />
        </div>
      )}
    </FormDialog>
  );
}

/** One switch per workspace of the owner's (Member.workspaces, Invite.workspaces), as a plug-in's Workspaces section has them. */
function WorkspaceSwitches({ brands, given, who, onChange }: { brands: Brand[]; given: string[]; who: string; onChange: (ids: string[]) => void }) {
  // the dot is the workspace's own colour, as the switcher and the row tags draw it: the team's list carries no colour
  const own = useWorkspace((s) => s.projects);
  return (
    <Card>
      {brands.map((b) => (
        <Row
          key={b.id}
          title={
            <span className="flex items-center gap-2">
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(own.find((p) => p.id === b.id) ?? b)].dot}`} />
              <span className="truncate">{b.name}</span>
            </span>
          }
          control={<Switch checked={given.includes(b.id)} aria-label={`${b.name} for ${who}`} onCheckedChange={(on) => onChange(on ? [...given, b.id] : given.filter((x) => x !== b.id))} />}
        />
      ))}
    </Card>
  );
}

/**
 * Which of the owner's workspaces a member, or the person an invite is for, works in: a switch each, saved with the
 * button. A workspace the owner no longer has is left out of what is saved.
 */
export function WorkspacesDialog({ who, brands, given, onClose, onSave }: { who: string; brands: Brand[]; given: string[]; onClose: () => void; onSave: (ids: string[]) => Promise<unknown> }) {
  const [ids, setIds] = useState(() => given.filter((id) => brands.some((b) => b.id === id)));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSave(ids);
      onClose();
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Workspaces for ${who}`} submitLabel="Save" onSubmit={submit} busy={busy}>
      <WorkspaceSwitches brands={brands} given={ids} who={who} onChange={setIds} />
    </FormDialog>
  );
}

type AccessPatch = { off?: string[]; read?: Tool[]; scripts?: boolean };
type Access = { off: string[]; read: Tool[]; scripts: boolean };
type Level = "write" | "read" | "off";
const LEVEL_TEXT: Record<Level, string> = { write: "opens and changes", read: "opens, changes nothing", off: "off" };
interface AccessRow extends Access {
  key: string;
  label: ReactNode;
  save: (patch: AccessPatch) => Promise<unknown>;
}

/**
 * Who opens what: a row for each member and each pending invite, a tick per app and one for reading your scripts. A tick
 * shows at once; `draft` holds a row while its save is on its way, so a second tick builds on the first, and a failed
 * save falls back to what the server has.
 */
function AccessGrid({ rows, gates }: { rows: AccessRow[]; gates: { id: string; name: string }[] }) {
  const [draft, setDraft] = useState<Record<string, Access>>({});
  const now = (r: AccessRow): Access => draft[r.key] ?? { off: r.off, read: r.read, scripts: r.scripts };
  const change = (r: AccessRow, next: Access, patch: AccessPatch) => {
    setDraft((d) => ({ ...d, [r.key]: next }));
    void r
      .save(patch)
      .catch((e) => saveFailed(msg(e)))
      .finally(() => setDraft((d) => (d[r.key] === next ? (({ [r.key]: _, ...rest }) => rest)(d) : d)));
  };
  const head = "px-1 pb-2 text-center align-bottom font-normal leading-tight";
  return (
    <Card>
      <div className="overflow-x-auto py-3 sm:py-4">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 z-10 bg-card pb-2 pl-3 pr-3 text-left align-bottom font-normal sm:pl-4">Person</th>
              {TOOLS.map((t) => (
                <th key={t} className={head}>
                  {TOOL_NAMES[t]}
                </th>
              ))}
              {gates.map((g) => (
                <th key={g.id} className={head}>
                  {g.name}
                </th>
              ))}
              <th className={head}>Your scripts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cur = now(r);
              const who = typeof r.label === "string" ? r.label : "this invite";
              return (
                <tr key={r.key} className="border-t border-border/50 hover:bg-accent/50">
                  <td className="sticky left-0 z-10 bg-card py-2 pl-3 pr-3 text-sm font-medium text-foreground sm:pl-4">
                    <span className="block max-w-[14rem] truncate">{r.label}</span>
                  </td>
                  {TOOLS.map((t: Tool) => {
                    const level: Level = cur.off.includes(t) ? "off" : cur.read.includes(t) ? "read" : "write";
                    // a click steps down, Read & write → Read → Off, and from Off back to Read & write
                    const next: Level = level === "write" ? "read" : level === "read" ? "off" : "write";
                    const off = offAfterToggle(cur.off, t, next !== "off");
                    const read = [...cur.read.filter((x) => x !== t), ...(next === "read" ? [t] : [])];
                    return <LevelTick key={t} level={level} title={`${TOOL_NAMES[t]} for ${who}: ${LEVEL_TEXT[level]}`} onClick={() => change(r, { ...cur, off, read }, { off, read })} />;
                  })}
                  {gates.map((g) => {
                    const off = offAfterToggle(cur.off, g.id, cur.off.includes(g.id));
                    return <Tick key={g.id} on={!cur.off.includes(g.id)} title={`${g.name} for ${who}`} onClick={() => change(r, { ...cur, off }, { off })} />;
                  })}
                  <Tick on={cur.scripts} title={`Your scripts for ${who}`} onClick={() => change(r, { ...cur, scripts: !cur.scripts }, { scripts: !cur.scripts })} />
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="flex items-center gap-x-4 whitespace-nowrap px-3 pt-3 text-xs text-muted-foreground sm:px-4">
          <span className="flex items-center gap-1.5"><LevelBox level="write" /> Opens and changes</span>
          <span className="flex items-center gap-1.5"><LevelBox level="read" /> Opens, changes nothing</span>
        </p>
      </div>
    </Card>
  );
}

function LevelBox({ level }: { level: Level }) {
  return (
    <span
      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
        level === "write"
          ? "border-violet-600 bg-violet-600 text-white group-hover:bg-violet-500"
          : level === "read"
            ? "border-violet-500 text-violet-400 group-hover:border-violet-400"
            : "border-muted-foreground/50 group-hover:border-muted-foreground"
      }`}
    >
      {level === "write" && <Check className="h-3 w-3" strokeWidth={3} />}
      {level === "read" && <Eye className="h-3 w-3" strokeWidth={2.5} />}
    </span>
  );
}

/** One app's cell in the Access grid: Read & write (a tick), Read (an eye) or Off (empty). */
function LevelTick({ level, title, onClick }: { level: Level; title: string; onClick: () => void }) {
  return (
    <td>
      <button onClick={onClick} aria-label={title} title={title} className="group flex w-full justify-center py-3">
        <LevelBox level={level} />
      </button>
    </td>
  );
}

/**
 * Makes an invite link (one person, 7 days), emailed when an address is given and the server can send email. The link
 * is shown here once; the pending list only has Delete.
 */
function InviteDialog({
  open,
  mail,
  brands,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  mail: boolean;
  brands: Brand[];
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [given, setGiven] = useState<string[]>([]);
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const close = (o: boolean) => {
    if (!o) {
      setLink(null);
      setEmail("");
      setSentTo("");
      setCopied(false);
      setGiven([]);
    }
    onOpenChange(o);
  };
  const make = async () => {
    setBusy(true);
    try {
      const to = email.trim();
      const { token } = await createInvite({ ai: "own", budgetUsd: 0, workspaces: given, ...(to ? { email: to } : {}) });
      setSentTo(to);
      setLink(inviteUrl(token));
      onCreated();
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      saveFailed("Could not copy. Select the link and copy it.");
    }
  };
  return (
    <SettingsDialog open={open} onOpenChange={close}>
      <SettingsDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New invite</DialogTitle>
          <DialogDescription>{!link ? "The link works for 7 days." : sentTo ? `Emailed to ${sentTo}.` : "The link is shown only once."}</DialogDescription>
        </DialogHeader>
        {mail && !link && (
          <Input
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void make()}
            placeholder="Email"
            aria-label="Email"
            className="h-8 text-sm"
          />
        )}
        {!link && brands.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Workspaces</p>
            <WorkspaceSwitches brands={brands} given={given} who="the invite" onChange={setGiven} />
          </div>
        )}
        {link && <code className="block truncate rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs">{link}</code>}
        <DialogFooter>
          {link ? (
            <>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button size="sm" onClick={() => close(false)}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void make()} disabled={busy}>
                {busy ? (email.trim() ? "Sending…" : "Creating…") : email.trim() ? "Send invite" : "Create link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </SettingsDialogContent>
    </SettingsDialog>
  );
}
