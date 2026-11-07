import { useEffect, useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import type { AiRoute, InviteInput, MemberView, WorkspaceRole, WorkspaceView } from "@contracts/workspaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useViewedMe } from "@/lib/auth";
import { createInvite, getWorkspace, inviteUrl, removeMember, renameWorkspace, revokeInvite, updateMember } from "@/lib/workspaces";
import { Card, Group, Loading, Notice, Row } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

const ROLE_NAMES: Record<WorkspaceRole, string> = { owner: "Owner", member: "Member" };
const usd = (n: number) => `$${n.toFixed(n < 10 && n % 1 ? 2 : 0)}`;

/** One member's AI, in words. */
function aiLine(m: MemberView, isMe: boolean): string {
  if (m.ai === "own") return isMe ? "Your own AI (Settings → AI providers)" : "Their own AI (Settings → AI providers on their Mac)";
  return `API budget ${usd(m.budgetUsd)} a month · ${usd(m.spentUsd)} used`;
}

/**
 * Settings → Workspace (contracts/workspaces.ts): the team, invite links, each member's AI and apps, and the plan. Owner or member,
 * nothing between: the owner changes things; a member sees who is in it and their own AI.
 */
export function WorkspaceSection() {
  const me = useViewedMe();
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
  if (view === null) return <Notice>You're not in a workspace. Someone who runs one sends you an invite link to join.</Notice>;

  const manager = view.me === "owner";

  return (
    <div>
      {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}

      <Group title="Workspace" hint="Your team. Everyone signs in with their own account; what they can open is set here.">
        <Card>
          <Row label="Name">
            {manager ? <NameInput key={view.workspace.name} name={view.workspace.name} onSave={(n) => void run(renameWorkspace(n))} /> : <span className="text-sm">{view.workspace.name}</span>}
          </Row>
          <Row
            label="Plan"
            hint={view.workspace.comped ? "Paid by the company that runs this server." : "Billing isn't set up yet."}
          >
            <span className="text-sm">{view.workspace.plan === "team" ? "Team" : "Free"} · {view.seats} {view.seats === 1 ? "seat" : "seats"}</span>
          </Row>
        </Card>
      </Group>

      <Group
        title="Members"
        hint={
          manager
            ? "Each member's AI and apps are set on their row."
            : undefined
        }
      >
        <Card>
          {view.members.map((m) => (
            <MemberRow key={m.username} m={m} view={view} isMe={m.username === me?.username} run={run} />
          ))}
        </Card>
      </Group>

      {manager && <InviteGroup view={view} run={run} />}

      {manager && (
        <Group
          title="AI for members"
          hint={
            view.budgets
              ? "Your own AI (Claude or ChatGPT on your Mac) answers only you. Each member either connects their own in Settings → AI providers, or gets a monthly budget on the workspace's API key, paid per call."
              : "Your own AI (Claude or ChatGPT on your Mac) answers only you. Each member connects their own in Settings → AI providers, or adds their own key in Settings → My API keys."
          }
        >
          {view.budgets && !view.apiKey && view.members.some((m) => m.ai === "budget") && (
            <Notice tone="warn">Some members are on an API budget, but this server has no Anthropic API key, so their AI is off.</Notice>
          )}
          {view.budgets && <Notice>Content Workshop always needs the member's own AI: it reads the whole project folder, which an API budget can't.</Notice>}
        </Group>
      )}
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
      aria-label="Workspace name"
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
  const full = editable || isMe;
  const patch = (p: Parameters<typeof updateMember>[1]) => void run(updateMember(m.username, p));
  const toggleApp = (t: Tool, on: boolean) => patch({ off: on ? m.off.filter((x) => x !== t) : [...m.off, t] });

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
        hint={full ? `${aiLine(m, isMe)} · active ${fmtAgo(m.lastActiveAt)}` : undefined}
      >
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            {view.budgets && <AiPicker key={m.budgetUsd} ai={m.ai} budget={m.budgetUsd} onChange={(ai, budgetUsd) => patch({ ai, budgetUsd })} label={m.username} />}
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setApps((a) => !a)} aria-expanded={apps}>
              Apps
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-red-500"
              aria-label={`Remove ${m.username} from the workspace`}
              onClick={() => window.confirm(`Remove ${m.username} from the workspace? Their account stays theirs.`) && void run(removeMember(m.username))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </Row>
      {apps && editable && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 px-3 pb-3">
          {TOOLS.map((t) => {
            const on = !m.off.includes(t);
            return (
              <label key={t} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={on} onChange={(e) => toggleApp(t, e.target.checked)} />
                {TOOL_NAMES[t]}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Own AI, or a monthly API budget with its amount. */
function AiPicker({ ai, budget, onChange, label }: { ai: AiRoute; budget: number; onChange: (ai: AiRoute, budgetUsd: number) => void; label: string }) {
  const [amount, setAmount] = useState(String(budget || 20));
  return (
    <span className="flex items-center gap-1.5">
      <select value={ai} onChange={(e) => onChange(e.target.value as AiRoute, Number(amount) || 0)} className={selectCls} aria-label={`${label}'s AI`}>
        <option value="own">Own AI</option>
        <option value="budget">API budget</option>
      </select>
      {ai === "budget" && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          $
          <Input
            type="number"
            min={0}
            step={5}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => Number(amount) !== budget && onChange("budget", Number(amount) || 0)}
            className="h-7 w-16 text-xs"
            aria-label={`${label}'s monthly budget in dollars`}
          />
          / mo
        </span>
      )}
    </span>
  );
}

function InviteGroup({ view, run }: { view: WorkspaceView; run: (p: Promise<unknown>) => Promise<void> }) {
  const [input, setInput] = useState<InviteInput>({ ai: "own", budgetUsd: 20 });
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setError(null);
    try {
      const { token } = await createInvite(input);
      setLink(inviteUrl(token));
      setCopied(false);
      await run(Promise.resolve(null));
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <Group title="Invite" hint="A link for one person, good for 7 days. They make their own account (or join with the one they have) and set their own password.">
      <Card>
        <Row label="New invite link">
          <div className="flex flex-wrap items-center gap-2">
            {view.budgets && <AiPicker ai={input.ai} budget={input.budgetUsd} onChange={(ai, budgetUsd) => setInput({ ...input, ai, budgetUsd })} label="The invited person" />}
            <Button size="sm" className="h-7 text-xs" onClick={() => void make()}>
              Create link
            </Button>
          </div>
        </Row>
        {link && (
          <div className="flex items-center gap-2 px-3 py-3">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{link}</code>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
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
          <Row
            key={i.id}
            label="Invite"
            hint={`${i.ai === "budget" ? `API budget ${usd(i.budgetUsd)} a month` : "Own AI"} · by ${i.createdBy} · expires ${new Date(i.expiresAt).toLocaleDateString()}`}
          >
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => void run(revokeInvite(i.id))}>
              Revoke
            </Button>
          </Row>
        ))}
      </Card>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
    </Group>
  );
}
