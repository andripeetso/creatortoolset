import { SettingsDialog } from "./kit-dialog";
import { ChevronDown, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import type { AiRoute, InvitePatch, MemberPatch, MemberView, WorkspaceView } from "@contracts/workspaces";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PROJECT_COLORS, projectColor } from "@/lib/workspace";
import { useMe } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { createInvite, getWorkspace, inviteUrl, offAfterToggle, removeMember, renameWorkspace, revokeInvite, setSignInWith, updateInvite, updateMember } from "@/lib/workspaces";
import { AskEveryone, Tick, useServerAccounts } from "@/components/AdminPanel";
import type { RowMenuItem } from "./kit-controls";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, TextField, saveFailed } from "./ui";
import { useSignInApps } from "./AccountSection";
import { lastActiveText, msg } from "./helpers";

type SignInProvider = "google" | "apple" | "github";
const PROVIDERS: SignInProvider[] = ["google", "apple", "github"];
const PROVIDER_NAME: Record<SignInProvider, string> = { google: "Google", apple: "Apple", github: "GitHub" };
const orList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? ""));

/**
 * How the team signs in (api/auth.ts ruleFor enforces it): a password too, each sign-in the server has switched on alone,
 * and all the switched-on ones together. `saved` is what the team has now; a sign-in that is switched off here stays as
 * the last choice so the value shown is the one that is enforced.
 */
export function signInOptions(on: readonly SignInProvider[], saved: readonly string[] = []): { id: string; label: string; value: SignInProvider[] }[] {
  const opts: { id: string; label: string; value: SignInProvider[] }[] = [{ id: "any", label: "Any way (password too)", value: [] }];
  for (const p of on) opts.push({ id: p, label: `${PROVIDER_NAME[p]} only`, value: [p] });
  if (on.length > 1) opts.push({ id: "all", label: orList(on.map((p) => PROVIDER_NAME[p])), value: [...on] });
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const kept = saved.filter((x): x is SignInProvider => (PROVIDERS as string[]).includes(x));
  if (kept.length && !opts.some((o) => same(o.value, kept))) opts.push({ id: "saved", label: orList(kept.map((p) => PROVIDER_NAME[p])), value: kept });
  return opts;
}
export const signInId = (opts: ReturnType<typeof signInOptions>, saved: readonly string[] | undefined) =>
  opts.find((o) => o.value.length === (saved ?? []).length && o.value.every((x) => (saved ?? []).includes(x)))?.id ?? "any";

/**
 * Settings → Team (hosted servers only). The owner renames the team, sets how it signs in, invites people and removes
 * them. A member sees the team and their own row. A platform admin also runs every account on the server here (each
 * member's menu, Create account, Other accounts, Ask everyone for a sign-in code; api/admin.ts). Access is one grid of everyone in the team and everyone invited: the
 * apps each may open (the account's `off`) and whether they read the owner's scripts; an invite's row is what that
 * person gets once they join (api/workspace.ts PATCH /invites/:id).
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
  // the sign-ins this server has switched on (the Account page's list): the team can only be set to these
  const apps = useSignInApps();
  const on: SignInProvider[] | null = apps ? PROVIDERS.filter((p) => apps[p]) : null;

  const refresh = saved.refresh;
  const load = useCallback(() => refresh().catch(() => {}), [refresh]);
  // a platform admin also runs the server's accounts here (was Admin → Accounts): passwords, locks, admin or not, delete
  const accounts = useServerAccounts(me?.role === "admin", () => void load());

  if (failed) {
    return (
      <Section title="Team">
        <Card>
          <ErrorRow title="The team did not load" retry={() => void load()} />
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
          <EmptyRow title="You're not in a team" description="Someone who runs one sends you an invite link to join." />
        </Card>
      </Section>
    );
  }

  const owner = view.me === "owner";
  if (!owner) {
    // a member can change nothing here: the team's name is the page, and their own line is the only row
    const mine = view.members.find((m) => m.username === me?.username);
    return (
      <Section title={view.workspace.name}>
        <Card>
          <ListRow title={me?.username ?? ""} subtitle={mine ? memberLine(mine, true, false) : undefined} />
        </Card>
      </Section>
    );
  }
  // every change reloads the view; a failure throws, so the control that asked shows its toast
  const act = (p: Promise<unknown>) => p.then(load);
  const attempt = (p: Promise<unknown>) => act(p).catch((e) => saveFailed(msg(e)));

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
                placeholder="Team name"
                value={view.workspace.name === "Workspace" || view.workspace.name === "Team" ? "" : view.workspace.name}
                onCommit={async (next) => {
                  if (!next.trim()) throw new Error("A team needs a name.");
                  await act(renameWorkspace(next.trim()));
                }}
              />
            }
          />
          {/* only when the server has a sign-in to require: with none there is nothing to choose, so no row */}
          {on !== null && on.length > 0 && (
            <Row
              id="team-sign-in"
              title="How the team signs in"
              control={
                (
                  <SettingsSelect
                    label="How the team signs in"
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

      {me?.role === "admin" && <AskEveryone />}

      <Section
        id="team-members"
        title="Members"
        action={
          <div className="flex gap-1">
            {me?.role === "admin" && (
              <Button size="xs" variant="ghost" onClick={accounts.create}>
                <Plus className="size-3" /> Create account
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => setInviting(true)}>
              <Plus className="size-3" /> Invite
            </Button>
          </div>
        }
      >
        <Card>
          {view.members.map((m) => {
            const self = m.username === me?.username;
            const acct = accounts.users?.find((u) => u.username === m.username);
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
                subtitle={[memberLine(m, self, true), acct?.role === "admin" && m.role !== "owner" ? "Admin" : null, acct?.locked ? "Locked" : null].filter(Boolean).join(" · ")}
                actions={
                  m.role !== "owner" && !self ? (
                    <>
                      <WorkspacePicker brands={view.brands ?? []} given={m.workspaces ?? []} onChange={(workspaces) => act(updateMember(m.username, { workspaces }))} />
                      <MemberMenu m={m} account={acct ? accounts.menuItems(acct) : []} onAi={() => setAiFor(m)} onRemove={() => attempt(removeMember(m.username))} />
                    </>
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
                title={i.email ? `Emailed to ${i.email}` : "Link for one person"}
                subtitle={`Expires ${new Date(i.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
                actions={
                  <>
                  <WorkspacePicker brands={view.brands ?? []} given={i.workspaces ?? []} onChange={(workspaces) => act(updateInvite(i.id, { workspaces }))} />
                  <RowMenu
                    label="More for this invite"
                    items={[{ label: "Revoke", destructive: true, confirm: { title: "Revoke this invite link?", body: "Nobody can join with it after this.", ok: "Revoke" }, onSelect: () => attempt(revokeInvite(i.id)) }]}
                  />
                  </>
                }
              />
            ))}
          </Card>
        </Section>
      )}

      {(view.members.some((m) => m.role !== "owner") || view.invites.length > 0) && (
        <Section id="team-access" title="Access">
          <AccessGrid
            rows={[
              ...view.members
                .filter((m) => m.role !== "owner")
                .map((m) => ({ key: m.username, label: m.name || m.username, off: m.off, scripts: !!m.scripts, save: (p: AccessPatch) => act(updateMember(m.username, p as MemberPatch)) })),
              ...view.invites.map((i) => ({
                key: i.id,
                label: (
                  <>
                    {i.email ?? "Invite link"} <span className="font-normal text-muted-foreground">invited</span>
                  </>
                ),
                off: i.off ?? [],
                scripts: !!i.scripts,
                save: (p: AccessPatch) => act(updateInvite(i.id, p as InvitePatch)),
              })),
            ]}
          />
        </Section>
      )}

      {(() => {
        // accounts on the server that are in no team: made by hand, or left one
        const others = accounts.users?.filter((u) => !view.members.some((m) => m.username === u.username)) ?? [];
        return (
          others.length > 0 && (
            <Section id="team-other-accounts" title="Other accounts">
              <Card>
                {others.map((u) => (
                  <ListRow key={u.username} title={u.name || u.username} subtitle={accounts.lineOf(u)} actions={<RowMenu label={`More for ${u.username}`} items={accounts.menuItems(u)} />} />
                ))}
              </Card>
            </Section>
          )
        );
      })()}

      {accounts.dialogs}
      <InviteDialog open={inviting} mail={Boolean(view.mail)} brands={view.brands ?? []} onOpenChange={setInviting} onCreated={() => void load()} />
      {aiFor && <AiDialog member={aiFor} onClose={() => setAiFor(null)} onSave={(m, patch) => act(updateMember(m.username, patch))} />}
    </>
  );
}

/** One line for a member: the role, and for the owner (and the person themselves) how their AI is paid. */
export function memberLine(m: MemberView, self: boolean, owner: boolean): string {
  const parts = [m.role === "owner" ? "Owner" : null];
  if (owner || self) {
    parts.push(m.ai === "own" ? (self ? "Your own AI" : "Own AI") : `API budget $${m.spentUsd.toFixed(2)} of $${m.budgetUsd} this month`);
    parts.push(lastActiveText(m.lastActiveAt));
  }
  return parts.filter(Boolean).join(" · ");
}

/** A member's AI, as the owner picks it (api/lib/workspaces.ts updateMember: `ai` and, for a budget, `budgetUsd`). */
const AI_CHOICES: { id: AiRoute; label: string }[] = [
  { id: "own", label: "Their own AI" },
  { id: "budget", label: "The team's key, up to a monthly budget" },
];

/** The budget a person typed: dollars, $1 to $10,000 a month (the server keeps it to cents and the same range). */
export function budgetFrom(text: string): { ok: true; usd: number } | { ok: false; error: string } {
  const n = Number(text.replace(/[$,\s]/g, ""));
  if (!text.trim() || !Number.isFinite(n) || n < 1 || n > 10_000) return { ok: false, error: "Enter a budget from $1 to $10,000 a month." };
  return { ok: true, usd: Math.round(n * 100) / 100 };
}

/** A member's menu: AI, the account's own items for a platform admin (`account`), Remove from team, Delete account last. */
function MemberMenu({ m, account, onAi, onRemove }: { m: MemberView; account: RowMenuItem[]; onAi: () => void; onRemove: () => Promise<void> }) {
  return (
    <RowMenu
      label={`More for ${m.username}`}
      items={[
        { label: "AI…", onSelect: onAi },
        ...account.filter((i) => !i.destructive),
        {
          label: "Remove from team",
          destructive: true,
          confirm: { title: `Remove ${m.username} from the team?`, body: "Their account stays theirs.", ok: "Remove" },
          onSelect: onRemove,
        },
        ...account.filter((i) => i.destructive),
      ]}
    />
  );
}

/** A member's AI: their own, or a monthly budget on the team's key. Saved with the button; a failed save is a toast. */
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
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`AI for ${member.username}`} submitLabel="Save AI" onSubmit={submit} busy={busy} error={error}>
      <SettingsSelect label="AI" value={mode} onValueChange={(v) => setMode(v as AiRoute)} options={AI_CHOICES.map((o) => ({ value: o.id, label: o.label }))} className="sm:w-full" />
      {mode === "budget" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Up to $</span>
          <Input aria-label="Monthly budget in dollars" inputMode="decimal" placeholder="25" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="h-8 w-24" />
          <span className="text-muted-foreground">a month</span>
        </div>
      )}
    </FormDialog>
  );
}

/**
 * Which of your workspaces a person works in (Member.workspaces): the row's own button, their workspaces' dots and
 * names, ticked in a menu that stays open. A tick shows at once; a failed save falls back to what the server has.
 */
function WorkspacePicker({ brands, given, onChange }: { brands: { id: string; name: string }[]; given: string[]; onChange: (ids: string[]) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string[] | null>(null);
  if (!brands.length) return null;
  const ids = (draft ?? given).filter((id) => brands.some((b) => b.id === id));
  const picked = brands.filter((b) => ids.includes(b.id));
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setDraft(next);
    void onChange(next)
      .catch((e) => saveFailed(msg(e)))
      .finally(() => setDraft((d) => (d === next ? null : d)));
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="max-w-[16rem] gap-1.5 font-normal text-muted-foreground" aria-label="Workspaces">
          {picked.length > 0 && (
            <span className="flex shrink-0 -space-x-0.5">
              {picked.slice(0, 3).map((b) => (
                <span key={b.id} className={`h-2 w-2 rounded-full ring-1 ring-card ${PROJECT_COLORS[projectColor(b)].dot}`} />
              ))}
            </span>
          )}
          <span className="truncate">{picked.length === 0 ? "No workspace" : picked.length === 1 ? picked[0]!.name : `${picked.length} workspaces`}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">Works in</DropdownMenuLabel>
        {brands.map((b) => (
          <DropdownMenuCheckboxItem key={b.id} checked={ids.includes(b.id)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggle(b.id)}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(b)].dot}`} />
            <span className="truncate">{b.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type AccessPatch = { off?: string[]; scripts?: boolean };
type Access = { off: string[]; scripts: boolean };
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
function AccessGrid({ rows }: { rows: AccessRow[] }) {
  const [draft, setDraft] = useState<Record<string, Access>>({});
  const now = (r: AccessRow): Access => draft[r.key] ?? { off: r.off, scripts: r.scripts };
  const change = (r: AccessRow, next: Access, patch: AccessPatch) => {
    setDraft((d) => ({ ...d, [r.key]: next }));
    void r
      .save(patch)
      .catch((e) => saveFailed(msg(e)))
      .finally(() => setDraft((d) => (d[r.key] === next ? (({ [r.key]: _, ...rest }) => rest)(d) : d)));
  };
  return (
    <Card>
      <div className="overflow-x-auto py-3 sm:py-4">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead>
            <tr className="text-[11px] leading-tight text-muted-foreground">
              <th className="sticky left-0 z-10 bg-card pb-2 pl-3 pr-3 text-left align-bottom text-[10px] font-medium uppercase tracking-wider sm:pl-4">Person</th>
              {TOOLS.map((t) => (
                <th key={t} className="px-1 pb-2 text-center align-bottom font-normal">
                  {TOOL_NAMES[t]}
                </th>
              ))}
              <th className="px-1 pb-2 text-center align-bottom font-normal">Your scripts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cur = now(r);
              return (
                <tr key={r.key} className="border-t border-border/50 hover:bg-accent/50">
                  <td className="sticky left-0 z-10 bg-card py-2 pl-3 pr-3 font-medium text-foreground sm:pl-4">
                    <span className="block max-w-[14rem] truncate">{r.label}</span>
                  </td>
                  {TOOLS.map((t: Tool) => {
                    const on = !cur.off.includes(t);
                    const off = offAfterToggle(cur.off, t, !on);
                    return <Tick key={t} on={on} title={`${TOOL_NAMES[t]} for ${typeof r.label === "string" ? r.label : "this invite"}`} onClick={() => change(r, { ...cur, off }, { off })} />;
                  })}
                  <Tick on={cur.scripts} title="Can read your scripts" onClick={() => change(r, { ...cur, scripts: !cur.scripts }, { scripts: !cur.scripts })} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Makes an invite link (one person, 7 days), emailed when an address is given and the server can send email. The link
 * is shown here once; the pending list only has Revoke.
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
  brands: { id: string; name: string }[];
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>
            {sentTo ? `Emailed to ${sentTo}. The link is good for 7 days.` : mail ? "Good for 7 days. Leave the email empty to copy the link yourself." : "Good for 7 days. Shown once: copy it now."}
          </DialogDescription>
        </DialogHeader>
        {mail && !link && (
          <Input
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void make()}
            placeholder="Their email"
            aria-label="Their email"
            className="h-8 text-sm"
          />
        )}
        {!link && brands.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Workspaces they work in</p>
            {brands.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={given.includes(b.id)} onCheckedChange={(on) => setGiven((g) => (on ? [...g, b.id] : g.filter((x) => x !== b.id)))} />
                <span className={`h-2 w-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(b)].dot}`} />
                {b.name}
              </label>
            ))}
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
                Done
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
      </DialogContent>
    </SettingsDialog>
  );
}
