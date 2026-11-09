import { useEffect, useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import type { MemberView, WorkspaceRole, WorkspaceView } from "@contracts/workspaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/lib/auth";
import { createInvite, getWorkspace, inviteUrl, removeMember, renameWorkspace, revokeInvite, setSignInWith, updateMember } from "@/lib/workspaces";
import { cn } from "@/lib/utils";
import { Card, Footnote, Group, Loading, Notice, Row } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

const ROLE_NAMES: Record<WorkspaceRole, string> = { owner: "Owner", member: "Member" };

/** How the team signs in (Settings → Team; the rule is enforced by api/auth.ts ruleFor). */
const SIGN_IN: { id: string; label: string; value: ("google" | "apple")[] }[] = [
  { id: "any", label: "Any way (password too)", value: [] },
  { id: "google", label: "Google only", value: ["google"] },
  { id: "apple", label: "Apple only", value: ["apple"] },
  { id: "both", label: "Google or Apple", value: ["google", "apple"] },
];

/**
 * Settings → Team (contracts/workspaces.ts; hosted servers only): the team, invite links and each member's apps. Owner
 * or member, nothing between: the owner changes things; a member sees who is in it. Every member uses their own AI:
 * API budgets are not wired on this server yet, so there is no budget to set.
 */
export function WorkspaceSection() {
  const me = useMe();
  const [view, setView] = useState<WorkspaceView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWorkspace().then(setView).catch((e) => setError(msg(e)));
  }, []);

  const run = async (p: Promise<WorkspaceView | unknown>) => {
    setError(null);
    try {
      const next = await p;
      setView(next && typeof next === "object" && "members" in next ? (next as WorkspaceView) : await getWorkspace());
    } catch (e) {
      setError(msg(e));
    }
  };

  if (view === undefined) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  if (view === null) return <Notice>You're not in a team. Someone who runs one sends you an invite link to join.</Notice>;

  const manager = view.me === "owner";

  return (
    <div>
      {error && <Notice tone="error">{error}</Notice>}

      <Group title="Details" hint="Everyone signs in with their own account.">
        <Card>
          <Row label="Name">
            {manager ? <NameInput key={view.workspace.name} name={view.workspace.name} onSave={(n) => void run(renameWorkspace(n))} /> : <span className="text-sm">{view.workspace.name}</span>}
          </Row>
          <Row label="Plan">
            <span className="text-sm">
              {view.workspace.plan === "team" ? "Team" : "Free"} · {view.seats} {view.seats === 1 ? "seat" : "seats"}
            </span>
          </Row>
          <Row label="Sign-in" hint="Google or Apple instead of a password. Link yours first in Settings → Account.">
            {manager ? (
              <select
                value={SIGN_IN.find((o) => o.value.join() === (view.workspace.signInWith ?? []).join())?.id ?? "any"}
                onChange={(e) => void run(setSignInWith(SIGN_IN.find((o) => o.id === e.target.value)?.value ?? []))}
                className={selectCls}
                aria-label="How the team signs in"
              >
                {SIGN_IN.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm">{SIGN_IN.find((o) => o.value.join() === (view.workspace.signInWith ?? []).join())?.label ?? "Any way"}</span>
            )}
          </Row>
        </Card>
      </Group>

      <Group title="Members" hint={manager ? "Set each member's apps on their row." : undefined}>
        <Card>
          {view.members.map((m) => (
            <MemberRow key={m.username} m={m} view={view} isMe={m.username === me?.username} run={run} />
          ))}
        </Card>
      </Group>

      {manager && <InviteGroup view={view} run={run} />}

      <Group title="AI for members">
        <Footnote>
          Each member answers with their own AI (Settings → AI providers on their own Mac). API budgets aren't set up on this
          server yet, so a member without an AI of their own has none until they add one.
        </Footnote>
      </Group>
    </div>
  );
}

function NameInput({ name, onSave }: { name: string; onSave: (n: string) => void }) {
  const [v, setV] = useState(name);
  return (
    <Input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== name && onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-8 w-56 text-sm"
      aria-label="Team name"
    />
  );
}

function MemberRow({
  m,
  view,
  isMe,
  run,
}: {
  m: MemberView;
  view: WorkspaceView;
  isMe: boolean;
  run: (p: Promise<unknown>) => Promise<void>;
}) {
  const [apps, setApps] = useState(false);
  // the owner changes everyone else; the owner's own row has nothing to change
  const editable = m.role !== "owner" && view.me === "owner";
  const toggleApp = (t: Tool, on: boolean) =>
    void run(updateMember(m.username, { off: on ? m.off.filter((x) => x !== t) : [...m.off, t] }));

  return (
    <div>
      <Row
        label={
          <span className="flex items-center gap-2">
            {m.username}
            {isMe && <span className="text-xs text-muted-foreground">(you)</span>}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{ROLE_NAMES[m.role]}</span>
          </span>
        }
        hint={isMe || view.me === "owner" ? `${aiLine(m, isMe)} · active ${fmtAgo(m.lastActiveAt)}` : undefined}
      >
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setApps((a) => !a)} aria-expanded={apps}>
              Apps
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-red-500"
              aria-label={`Remove ${m.username} from the team`}
              onClick={() => window.confirm(`Remove ${m.username} from the team? Their account stays theirs.`) && void run(removeMember(m.username))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </Row>
      {apps && editable && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 px-3 pb-3">
          {TOOLS.map((t) => (
            <label key={t} className={cn("flex items-center gap-1.5 text-xs")}>
              <input type="checkbox" checked={!m.off.includes(t)} onChange={(e) => toggleApp(t, e.target.checked)} />
              {TOOL_NAMES[t]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** One member's AI, in words. A budget row can exist from before; it has no effect on this server yet. */
function aiLine(m: MemberView, isMe: boolean): string {
  if (m.ai === "own") return isMe ? "Your own AI" : "Their own AI";
  return "API budget (not set up on this server: no AI)";
}

function InviteGroup({ view, run }: { view: WorkspaceView; run: (p: Promise<unknown>) => Promise<void> }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setError(null);
    try {
      const { token } = await createInvite({ ai: "own", budgetUsd: 0 });
      setLink(inviteUrl(token));
      setCopied(false);
      await run(Promise.resolve(null));
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <Group title="Invite" hint="A link for one person, good for 7 days.">
      <Card>
        <Row label="New invite link">
          <Button size="sm" onClick={() => void make()}>
            Create link
          </Button>
        </Row>
        {link && (
          <div className="flex items-center gap-2 px-3 py-3">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{link}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
        {view.invites.map((i) => (
          <Row key={i.id} label="Invite" hint={`Own AI · by ${i.createdBy} · expires ${new Date(i.expiresAt).toLocaleDateString()}`}>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void run(revokeInvite(i.id))}>
              Revoke
            </Button>
          </Row>
        ))}
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
    </Group>
  );
}
