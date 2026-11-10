import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import type { MemberView, WorkspaceView } from "@contracts/workspaces";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useMe } from "@/lib/auth";
import { createInvite, getWorkspace, inviteUrl, removeMember, renameWorkspace, revokeInvite, setSignInWith, updateMember } from "@/lib/workspaces";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, TextField, saveFailed } from "./ui";
import { fmtAgo, msg } from "./helpers";

/** How the team signs in (api/auth.ts ruleFor enforces it). The value is the set of providers, empty = a password too. */
const SIGN_IN: { id: string; label: string; value: ("google" | "apple")[] }[] = [
  { id: "any", label: "Any way (password too)", value: [] },
  { id: "google", label: "Google only", value: ["google"] },
  { id: "apple", label: "Apple only", value: ["apple"] },
  { id: "both", label: "Google or Apple", value: ["google", "apple"] },
];
const signInId = (v: string[] | undefined) => SIGN_IN.find((o) => o.value.join() === (v ?? []).join())?.id ?? "any";

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
  // every change reloads the view; a failure throws, so the control that asked shows its toast
  const act = (p: Promise<unknown>) => p.then(load);
  const attempt = (p: Promise<unknown>) => act(p).catch((e) => saveFailed(msg(e)));
  const signIn = SIGN_IN.find((o) => o.id === signInId(view.workspace.signInWith));

  return (
    <>
      <Section title="Team">
        <Card>
          {owner ? (
            <Row
              id="team-name"
              title="Team name"
              control={
                <TextField
                  label="Team name"
                  value={view.workspace.name}
                  onCommit={async (next) => {
                    if (!next.trim()) throw new Error("A team needs a name.");
                    await act(renameWorkspace(next.trim()));
                  }}
                />
              }
            />
          ) : (
            <Row id="team-name" title="Team name" status={view.workspace.name} />
          )}
          <Row
            id="team-sign-in"
            title="How the team signs in"
            status={owner ? undefined : signIn?.label}
            control={
              owner ? (
                <SettingsSelect
                  label="How the team signs in"
                  value={signInId(view.workspace.signInWith)}
                  options={SIGN_IN.map((o) => ({ value: o.id, label: o.label }))}
                  onValueChange={(id) => void attempt(setSignInWith(SIGN_IN.find((o) => o.id === id)?.value ?? []))}
                />
              ) : undefined
            }
          />
        </Card>
      </Section>

      <Section
        id="team-members"
        title="Members"
        action={
          owner ? (
            <Button size="xs" variant="ghost" onClick={() => setInviting(true)}>
              + Invite
            </Button>
          ) : undefined
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
                    {m.username}
                    {self && <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>}
                  </>
                }
                subtitle={memberLine(m, self, owner)}
                actions={owner && m.role !== "owner" && !self ? <MemberMenu m={m} canEditHere={me?.role !== "admin"} onTools={() => setEditing(m)} onAdmin={() => navigate("/settings/admin/access")} onRemove={() => attempt(removeMember(m.username))} /> : undefined}
              />
            );
          })}
        </Card>
      </Section>

      {owner && view.invites.length > 0 && (
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
      <ToolsDialog member={editing} onClose={() => setEditing(null)} onChange={(m, off) => attempt(updateMember(m.username, { off }))} />
    </>
  );
}

/** One line for a member: the role, and for the owner (and the person themselves) how their AI is paid. */
function memberLine(m: MemberView, self: boolean, owner: boolean): string {
  const parts = [m.role === "owner" ? "Owner" : null];
  if (owner || self) {
    parts.push(m.ai === "own" ? (self ? "Your own AI" : "Own AI") : `API budget $${m.spentUsd.toFixed(2)} of $${m.budgetUsd} this month`);
    parts.push(`active ${fmtAgo(m.lastActiveAt)}`);
  }
  return parts.filter(Boolean).join(" · ");
}

function MemberMenu({ m, canEditHere, onTools, onAdmin, onRemove }: { m: MemberView; canEditHere: boolean; onTools: () => void; onAdmin: () => void; onRemove: () => Promise<void> }) {
  return (
    <RowMenu
      label={`More for ${m.username}`}
      items={[
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
          <DialogDescription>A link for one person, good for 7 days. Copy it now: it is not shown again.</DialogDescription>
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
