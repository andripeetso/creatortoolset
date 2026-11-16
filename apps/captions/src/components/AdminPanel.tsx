import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { confirmDialog } from "@/lib/dialogs";
import { TOOL_NAMES, type Tool } from "@contracts/tools";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useCodeState } from "@/components/SignInCode";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, saveFailed, type RowMenuItem } from "@/components/settings/ui";
import { fmtAgo, lastActiveText, msg } from "@/components/settings/helpers";

/**
 * The server's own lists for its admins (api/admin.ts), drawn where each belongs since Admin was taken apart
 * (2026-11-14): every account in Settings → Team → Accounts (useServerAccounts, AskEveryone), every project in Settings → Storage
 * (ServerProjects). The lists are read through their saved copies (lib/local-cache.ts): the rows are there on the first
 * frame of a reload and when the server can't be reached, and they are read again behind that and after each change.
 */

/** Stored as the account's role: admin, team or user. Team and user differ only on a server with an age limit (CONTENT_EXPIRES=1, api/retention.ts): files kept 28 days after they last change, or 14. */
type Role = "user" | "team" | "admin";

interface AdminUser {
  username: string;
  name?: string;
  role: Role;
  off: Tool[];
  createdAt: number;
  usage: { logins: number; lastActiveAt: number };
  /** Has the sign-in code on; is held by the lock on wrong tries (api/admin.ts). */
  code?: boolean;
  locked?: boolean;
  projects: number;
  instagramPosts?: number;
  storageBytes: number;
  /** Set on a server with an age limit: the days this account's files stay after they last change. */
  keepDays?: number;
}

interface AdminProject {
  id: string;
  kind: "captions" | "enhance";
  name: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const read = <T,>(url: string) => () => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`Request failed (${r.status})`))));
/** own: this window's saves read the list again too, so a change saved while the list was still being read is not undone by that older read. */
const ACCOUNTS_LIVE = { own: true };
/** A project is deleted through its own tool's address, so the list follows those too. */
const PROJECTS_LIVE = { topic: ["admin", "projects", "enhance"], own: true };

export type { AdminUser };

/**
 * Every account on the server, for an admin (Settings → Team → Accounts): the list, each account's menu (password,
 * lock, sign-in code, admin or not, how long its files are kept, delete) and the dialogs those open. `on` false (not an
 * admin) reads nothing. `changed` runs after each change, so the page around it reads its own list again too.
 */
export function useServerAccounts(on: boolean, changed: () => void) {
  const accounts = useCachedLoad<AdminUser[]>(on ? "/api/admin/users" : null, read<AdminUser[]>("/api/admin/users"), ACCOUNTS_LIVE);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const refresh = () => accounts.refresh().catch(() => {});
  /** One change to the server; a failure throws (the caller's toast says why) and the view keeps what it had. */
  const call = async (path: string, init: RequestInit) => {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error || "That did not save. Try again.");
    }
    await refresh();
    changed();
  };
  const attempt = (p: Promise<unknown>) => p.catch((e) => saveFailed(msg(e)));
  const patch = (u: AdminUser, change: object) => attempt(call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify(change) }));
  const changeRole = (u: AdminUser, role: Role) => patch(u, { role });
  const menuItems = (u: AdminUser): RowMenuItem[] => {
    const admin = u.role === "admin";
    return [
      { label: "Reset password…", onSelect: () => setResetFor(u) },
      ...(u.locked ? [{ label: "Unlock account", onSelect: () => patch(u, { unlock: true }) }] : []),
      ...(u.code ? [{ label: "Turn off sign-in code", confirm: { title: `Turn off ${u.username}'s sign-in code?`, ok: "Turn off" }, onSelect: () => patch(u, { code: false }) }] : []),
      admin
        ? { label: "Remove admin", confirm: { title: `Remove ${u.username} as admin?`, ok: "Remove admin" }, onSelect: () => changeRole(u, "team") }
        : { label: "Make admin", confirm: { title: `Make ${u.username} an admin?`, body: "Admins see every project and manage accounts.", ok: "Make admin" }, onSelect: () => changeRole(u, "admin") },
      // the two roles below admin differ only in how long files are kept, so the item says that; only on a server with an age limit
      ...(admin || !u.keepDays ? [] : [{ label: u.role === "team" ? "Keep files 14 days" : "Keep files 28 days", onSelect: () => changeRole(u, u.role === "team" ? "user" : "team") }]),
      {
        label: "Delete account",
        destructive: true,
        // api/admin.ts DELETE /users/:name: its projects, videos and designs go with it (retention.ts deleteUserContent)
        confirm: { title: `Delete account "${u.username}"?`, body: "The account and its files on the server are deleted.", ok: "Delete account" },
        onSelect: () => attempt(call(`/api/admin/users/${u.username}`, { method: "DELETE" })),
      },
    ];
  };
  /** The account's line: Admin, Locked, its projects and what it keeps. */
  const lineOf = (u: AdminUser) =>
    [u.role === "admin" ? "Admin" : null, u.locked ? "Locked" : null, lastActiveText(u.usage.lastActiveAt), u.projects ? `${u.projects} project${u.projects === 1 ? "" : "s"}` : null, u.storageBytes > 0 ? fmtBytes(u.storageBytes) : null]
      .filter(Boolean)
      .join(" · ");
  const dialogs = (
    <>
      <CreateAccount open={creating} onOpenChange={setCreating} onCreated={() => void refresh().then(changed)} />
      <ResetPassword user={resetFor} onClose={() => setResetFor(null)} call={call} />
    </>
  );
  return { users: accounts.data, failed: !accounts.data && !!accounts.error, retry: () => void refresh(), menuItems, lineOf, create: () => setCreating(true), dialogs };
}

/** Every project on the server, newest first, each with its tool, owner, size and Delete (Settings → Storage, admins on a hosted server). */
export function ServerProjects() {
  const me = useAuth((s) => s.me);
  const made = useCachedLoad<AdminProject[]>("/api/admin/projects", read<AdminProject[]>("/api/admin/projects"), PROJECTS_LIVE);
  const projects = made.data;
  const failed = !projects && !!made.error;
  const refresh = () => made.refresh().catch(() => {});
  /** A failure throws: the row's menu says it in a toast. */
  const removeProject = async (p: AdminProject) => {
    const res = await fetch(`${p.kind === "captions" ? "/api/projects" : "/api/enhance"}/${p.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) throw new Error("Could not delete the project. Try again.");
    await refresh();
  };
  return (
    <Section id="admin-projects" title="All projects">
      <Card>
        {failed && <ErrorRow title="Could not load projects" retry={() => void refresh()} />}
        {!projects && !failed && <LoadingRow />}
        {projects?.length === 0 && <EmptyRow title="No projects" />}
        {projects &&
          [...projects]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((p) => (
              <ListRow
                key={`${p.kind}:${p.id}`}
                title={p.name}
                subtitle={[TOOL_NAMES[p.kind], p.owner, `updated ${fmtAgo(p.updatedAt)}`, p.bytes > 0 ? fmtBytes(p.bytes) : null].filter(Boolean).join(" · ")}
                actions={
                  <RowMenu
                    label={`More for ${p.name}`}
                    items={[
                      {
                        label: "Delete",
                        destructive: true,
                        confirm: { title: `Delete project "${p.name}"?`, body: p.owner && p.owner !== me?.username ? `Owner: ${p.owner}.` : undefined },
                        onSelect: () => removeProject(p),
                      },
                    ]}
                  />
                }
              />
            ))}
      </Card>
    </Section>
  );
}

/** The sign-in code for everyone: every password sign-in on this server needs one (PUT /api/admin/sign-in-code). */
export function AskEveryone() {
  const state = useCodeState();
  if (!state.data) return null;
  const change = async (on: boolean) => {
    if (on && !(await confirmDialog({ title: "Turn on the sign-in code for everyone?", body: "Everyone without one is signed out and sets one up at their next sign-in.", ok: "Turn on" }))) return;
    const res = await fetch("/api/admin/sign-in-code", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ required: on }) }).catch(() => null);
    const d = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string; required?: boolean };
    if (!res?.ok) return saveFailed(d.error || "That did not save. Try again.");
    state.set((v) => v && { ...v, required: !!d.required });
  };
  return (
    <Section title="Sign-in">
      <Card>
        <Row
          id="admin-sign-in-code"
          title="Code"
          description="Every password sign-in on this server needs a code from an authenticator app."
          control={<Switch checked={state.data.required} aria-label="Sign-in code" onCheckedChange={(on) => void change(on)} />}
        />
      </Card>
    </Section>
  );
}

/** Makes an account: a username and a password of at least ten characters (api/admin.ts POST /users). */
function CreateAccount({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (password.length < 10) return setError("The password needs at least 10 characters.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Could not create the account.");
      setUsername("");
      setPassword("");
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="New account" submitLabel="Create" busy={busy} error={error} onSubmit={submit}>
      <Input aria-label="Username" placeholder="Username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
      <Input aria-label="Password" placeholder="Password, 10 characters or more" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required />
    </FormDialog>
  );
}

/** Sets a new password for one account (PATCH /api/admin/users/:name with `password`). */
function ResetPassword({ user, onClose, call }: { user: AdminUser | null; onClose: () => void; call: (p: string, i: RequestInit) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!user) return;
    if (password.length < 10) return setError("The password needs at least 10 characters.");
    setBusy(true);
    setError(null);
    try {
      await call(`/api/admin/users/${user.username}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setPassword("");
      onClose();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog open={user !== null} onOpenChange={(o) => !o && onClose()} title={`New password for ${user?.username ?? ""}`} submitLabel="Save" busy={busy} error={error} onSubmit={() => submit()}>
      <Input aria-label="New password" type="text" placeholder="New password, 10 characters or more" value={password} onChange={(e) => setPassword(e.target.value)} required />
    </FormDialog>
  );
}

/** One checkbox cell in the Access grid; the whole cell is the click target. */
export function Tick({ on, disabled, title, onClick }: { on: boolean; disabled?: boolean; title: string; onClick: () => void }) {
  return (
    <td>
      <button onClick={onClick} disabled={disabled} role="checkbox" aria-checked={on} aria-label={title} title={title} className="group flex w-full justify-center py-3 disabled:cursor-default">
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
            on ? "border-violet-600 bg-violet-600 text-white group-enabled:group-hover:bg-violet-500" : "border-muted-foreground/50 group-enabled:group-hover:border-muted-foreground"
          } ${disabled ? "opacity-40" : ""}`}
        >
          {on && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      </button>
    </td>
  );
}
