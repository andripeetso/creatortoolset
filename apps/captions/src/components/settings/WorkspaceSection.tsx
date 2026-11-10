import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import type { AiRoute, MemberPatch, MemberView, WorkspaceView } from "@contracts/workspaces";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useMe } from "@/lib/auth";
import { createInvite, getWorkspace, inviteUrl, removeMember, renameWorkspace, revokeInvite, setSignInWith, updateMember } from "@/lib/workspaces";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, TextField, saveFailed } from "./ui";
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
 * them. A member sees the team and their own row. Tools for a member are edited in one place for each viewer: a team
 * owner who is not a platform admin changes them here; a platform admin changes them in Admin → Access (the same
 * account setting, api/admin.ts and api/workspace.ts both write `off`).
 */
export function WorkspaceSection() {
  const me = useMe();
  const navigate = useNavigate();
  const [view, setView] = useState<WorkspaceView | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<MemberView | null>(null);
  const [aiFor, setAiFor] = useState<MemberView | null>(null);
  // the sign-ins this server has switched on (the Account page's list): the team can only be set to these
  const [on, setOn] = useState<SignInProvider[] | null>(null);
  useEffect(() => {
    const none: Partial<Record<SignInProvider, boolean>> = {};
    fetch("/api/account/providers")
      .then((r) => (r.ok ? (r.json() as Promise<Partial<Record<SignInProvider, boolean>>>) : none))
      .then((d) => setOn(PROVIDERS.filter((p) => d[p])))
      .catch(() => setOn([]));
  }, []);

  const load = useCallback(() => {
    setFailed(false);
    return getWorkspace().then(setView, () => setFailed(true));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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
                value={view.workspace.name === "Workspace" ? "" : view.workspace.name}
                onCommit={async (next) => {
                  if (!next.trim()) throw new Error("A team needs a name.");
                  await act(renameWorkspace(next.trim()));
                }}
              />
            }
          />
          {on !== null && (
            <Row
              id="team-sign-in"
              title="How the team signs in"
              description={on.length === 0 ? "Google, Apple or GitHub sign-in must be set up on the server first (Settings → Account)." : undefined}
              control={
                on.length === 0 ? (
                  <span className="text-sm text-muted-foreground">Any way (password too)</span>
                ) : (
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
                subtitle={memberLine(m, self, true)}
                actions={m.role !== "owner" && !self ? <MemberMenu m={m} canEditHere={me?.role !== "admin"} onAi={() => setAiFor(m)} onTools={() => setEditing(m)} onAdmin={() => navigate("/settings/admin/access")} onRemove={() => attempt(removeMember(m.username))} /> : undefined}
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
                title="Link for one person"
                subtitle={`Expires ${new Date(i.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
                actions={
                  <RowMenu
                    label="More for this invite"
                    items={[{ label: "Revoke", destructive: true, confirm: { title: "Revoke this invite link?", body: "Nobody can join with it after this.", ok: "Revoke" }, onSelect: () => attempt(revokeInvite(i.id)) }]}
                  />
                }
              />
            ))}
          </Card>
        </Section>
      )}

      <InviteDialog open={inviting} onOpenChange={setInviting} onCreated={() => void load()} />
      {aiFor && <AiDialog member={aiFor} onClose={() => setAiFor(null)} onSave={(m, patch) => act(updateMember(m.username, patch))} />}
      <ToolsDialog member={editing} onClose={() => setEditing(null)} onChange={(m, off) => attempt(updateMember(m.username, { off }))} />
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

function MemberMenu({ m, canEditHere, onAi, onTools, onAdmin, onRemove }: { m: MemberView; canEditHere: boolean; onAi: () => void; onTools: () => void; onAdmin: () => void; onRemove: () => Promise<void> }) {
  return (
    <RowMenu
      label={`More for ${m.username}`}
      items={[
        { label: "AI…", onSelect: onAi },
        canEditHere
          ? { label: "Tools…", onSelect: onTools }
          : { label: "Tools in Admin", onSelect: onAdmin },
        {
          label: "Remove from team",
          destructive: true,
          confirm: { title: `Remove ${m.username} from the team?`, body: "Their account stays theirs.", ok: "Remove" },
          onSelect: onRemove,
        },
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

/** A member's apps: one switch per app, each saved at once (the `off` list of the account). */
function ToolsDialog({ member, onClose, onChange }: { member: MemberView | null; onClose: () => void; onChange: (m: MemberView, off: Tool[]) => Promise<void> }) {
  if (!member) return null;
  const toggle = (t: Tool, on: boolean) => {
    const off = member.off.filter((x): x is Tool => (TOOLS as readonly string[]).includes(x) && x !== t);
    if (!on) off.push(t);
    void onChange(member, off);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tools for {member.username}</DialogTitle>
        </DialogHeader>
        <Card>
          {TOOLS.map((t) => (
            <Row key={t} title={TOOL_NAMES[t]} control={<Switch checked={!member.off.includes(t)} aria-label={TOOL_NAMES[t]} onCheckedChange={(on) => toggle(t, on)} />} />
          ))}
        </Card>
      </DialogContent>
    </Dialog>
  );
}

/** Makes an invite link (one person, 7 days). The link is shown here once; the pending list only has Revoke. */
function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const close = (o: boolean) => {
    if (!o) {
      setLink(null);
      setCopied(false);
    }
    onOpenChange(o);
  };
  const make = async () => {
    setBusy(true);
    try {
      const { token } = await createInvite({ ai: "own", budgetUsd: 0 });
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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>Good for 7 days. Shown once: copy it now.</DialogDescription>
        </DialogHeader>
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
                {busy ? "Creating…" : "Create link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
