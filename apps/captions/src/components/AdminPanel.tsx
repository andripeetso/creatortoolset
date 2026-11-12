import { Fragment, useState, type FormEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { confirmDialog } from "@/lib/dialogs";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useCodeState } from "@/components/SignInCode";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, saveFailed } from "@/components/settings/ui";
import { fmtAgo, lastActiveText, msg } from "@/components/settings/helpers";

/**
 * Settings → Admin (hosted servers, platform admins only): accounts, the apps each one gets (Access), and every project on
 * the server. Admin API: api/admin.ts. Ticks in Access move and save at once; a failed save is a toast and the tick goes
 * back to the saved state. The lists are read through their saved copies (lib/local-cache.ts): the rows are there on the first frame
 * of a reload and when the server can't be reached, and they are read again behind that and when an admin changes one.
 */

/** Stored as the account's role: admin, team (files kept 28 days after they last change), or user (14). */
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

export type AdminTab = "users" | "access" | "projects";

// the team and plain roles differ in how long their files are kept: that is in the role's menu, not in the row
const ROLE_NAME: Record<Role, string> = { admin: "Admin", team: "Member", user: "Member" };

function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const tableCls = "w-full text-left text-xs";

const read = <T,>(url: string) => () => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`Request failed (${r.status})`))));
/** own: this window's saves read the list again too, so a tick saved while the list was still being read is not undone by that older read. */
const ACCOUNTS_LIVE = { own: true };
/** A project is deleted through its own tool's address, so the list follows those too. */
const PROJECTS_LIVE = { topic: ["admin", "projects", "enhance"], own: true };

export function AdminPanel({ tab }: { tab: AdminTab }) {
  const me = useAuth((s) => s.me);
  const accounts = useCachedLoad<AdminUser[]>("/api/admin/users", read<AdminUser[]>("/api/admin/users"), ACCOUNTS_LIVE);
  const made = useCachedLoad<AdminProject[]>(tab === "projects" ? "/api/admin/projects" : null, read<AdminProject[]>("/api/admin/projects"), PROJECTS_LIVE);
  const users = accounts.data;
  const projects = made.data;
  // an error row only when there is nothing to show: with a saved copy the rows stay (offline, a server restart)
  const usersFailed = !users && !!accounts.error;
  const projectsFailed = !projects && !!made.error;
  const refresh = () => accounts.refresh().catch(() => {});
  const refreshProjects = () => made.refresh().catch(() => {});
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);

  /** One change to the server; a failure throws (the caller's toast says why) and the view keeps what it had. */
  const call = async (path: string, init: RequestInit) => {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error || `Could not save it (${res.status})`);
    }
    await refresh();
  };
  const attempt = (p: Promise<unknown>) => p.catch((e) => saveFailed(msg(e)));

  // Access: a tick shows at once. `ticked` holds an account's apps while their save is on its way; a save that lands goes
  // into the saved list (which also drops a read that started before it), one that fails falls back to what was saved
  const [ticked, setTicked] = useState<Record<string, Tool[]>>({});
  const offOf = (u: AdminUser) => ticked[u.username] ?? u.off;
  const toggleApp = (u: AdminUser, t: Tool) => {
    const off = offOf(u).includes(t) ? offOf(u).filter((x) => x !== t) : [...offOf(u), t];
    setTicked((m) => ({ ...m, [u.username]: off }));
    return fetch(`/api/admin/users/${u.username}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ off }) })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Could not save it (${res.status})`);
        accounts.set((list) => list && list.map((x) => (x.username === u.username ? { ...x, off } : x)));
      })
      .catch((e) => saveFailed(msg(e)))
      // a newer tick on the same account keeps its own entry
      .finally(() =>
        setTicked((m) => {
          const { [u.username]: mine, ...rest } = m;
          return mine === off ? rest : m;
        }),
      );
  };
  const changeRole = (u: AdminUser, role: Role) => attempt(call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ role }) }));
  const removeAccount = (u: AdminUser) => attempt(call(`/api/admin/users/${u.username}`, { method: "DELETE" }));
  const patch = (u: AdminUser, change: object) => attempt(call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify(change) }));
  const removeProject = async (p: AdminProject) => {
    const ok = await confirmDialog({
      title: `Delete project "${p.name}"?`,
      body: p.owner && p.owner !== me?.username ? `Owner: ${p.owner}.` : undefined,
      ok: "Delete project",
      danger: true,
    });
    if (!ok) return;
    const base = p.kind === "captions" ? "/api/projects" : "/api/enhance";
    const res = await fetch(`${base}/${p.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      saveFailed("The project was not deleted. Try again.");
      return;
    }
    await refreshProjects();
    void refresh();
  };

  if (tab === "users") {
    return (
      <>
        <Section
          id="admin-accounts"
          title="Accounts"
          action={
            <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
              <Plus className="size-3" /> Create account
            </Button>
          }
        >
          <Card>
            {usersFailed && <ErrorRow title="The accounts did not load." retry={() => void refresh()} />}
            {!users && !usersFailed && <LoadingRow />}
            {users?.length === 0 && <EmptyRow title="No accounts yet" />}
            {users?.map((u) => {
              const you = u.username === me?.username;
              const admin = u.role === "admin";
              const parts = [
                ROLE_NAME[u.role],
                u.locked ? "Locked" : null,
                lastActiveText(u.usage.lastActiveAt),
                u.projects ? `${u.projects} projects` : null,
                fmtBytes(u.storageBytes) !== "—" ? fmtBytes(u.storageBytes) : null,
              ].filter(Boolean);
              return (
                <ListRow
                  key={u.username}
                  title={
                    <>
                      {u.name || u.username}
                      {u.name && <span className="ml-1.5 font-normal text-muted-foreground">{u.username}</span>}
                      {you && <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>}
                    </>
                  }
                  subtitle={parts.join(" · ")}
                  actions={
                    you ? undefined : (
                      <RowMenu
                        label={`More for ${u.username}`}
                        items={[
                          { label: "Reset password…", onSelect: () => setResetFor(u) },
                          ...(u.locked ? [{ label: "Lift the lock", onSelect: () => patch(u, { unlock: true }) }] : []),
                          ...(u.code ? [{ label: "Switch off sign-in code", confirm: { title: `Switch off ${u.username}'s sign-in code?`, ok: "Switch off" }, onSelect: () => patch(u, { code: false }) }] : []),
                          admin
                            ? { label: "Remove admin", confirm: { title: `Remove ${u.username} as admin?`, ok: "Remove admin" }, onSelect: () => changeRole(u, "team") }
                            : { label: "Make admin", confirm: { title: `Make ${u.username} an admin?`, body: "Admins see every project and manage accounts.", ok: "Make admin" }, onSelect: () => changeRole(u, "admin") },
                          ...(admin
                            ? []
                            : [
                                {
                                  label: u.role === "team" ? "Make a plain member (files kept 14 days)" : "Make a team member (files kept 28 days)",
                                  onSelect: () => changeRole(u, u.role === "team" ? "user" : "team"),
                                },
                              ]),
                          {
                            label: "Delete account",
                            destructive: true,
                            confirm: { title: `Delete account "${u.username}"?`, body: "It leaves its team and loses its library grants. Its files stay on the server.", ok: "Delete account" },
                            onSelect: () => removeAccount(u),
                          },
                        ]}
                      />
                    )
                  }
                />
              );
            })}
          </Card>
        </Section>
        <AskEveryone />
        <CreateAccount open={creating} onOpenChange={setCreating} onCreated={() => void refresh()} />
        <ResetPassword user={resetFor} onClose={() => setResetFor(null)} call={call} />
      </>
    );
  }

  if (tab === "access") {
    return (
      <Section id="admin-access" title="Access">
        <Card>
          {usersFailed && <ErrorRow title="The accounts did not load." retry={() => void refresh()} />}
          {!users && !usersFailed && <LoadingRow />}
          {users && (
            <div className="overflow-x-auto py-3 sm:py-4">
              <table className={`${tableCls} min-w-[640px]`}>
                <thead>
                  <tr className="text-[11px] leading-tight text-muted-foreground">
                    <th className="sticky left-0 z-10 bg-card pb-2 pl-3 pr-3 text-left align-bottom text-[10px] font-medium uppercase tracking-wider sm:pl-4">Account</th>
                    {TOOLS.map((t) => (
                      <th key={t} className="px-1 pb-2 text-center align-bottom font-normal">
                        {TOOL_NAMES[t]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const admin = u.role === "admin";
                    const you = u.username === me?.username;
                    return (
                      <Fragment key={u.username}>
                        <tr className="border-t border-border/50 hover:bg-accent/50">
                          <td className="sticky left-0 z-10 bg-card py-2 pl-3 pr-3 font-medium text-foreground sm:pl-4">
                            <span className="block max-w-[10rem] truncate">
                              {u.username}
                              {you && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(you)</span>}
                            </span>
                          </td>
                          {TOOLS.map((t) => (
                            <Tick key={t} on={admin || !offOf(u).includes(t)} disabled={admin} title={`${TOOL_NAMES[t]} for ${u.username}`} onClick={() => void toggleApp(u, t)} />
                          ))}
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>
    );
  }

  return (
    <Section id="admin-projects" title="Projects">
      <Card>
        {projectsFailed && <ErrorRow title="The projects did not load." retry={() => void refreshProjects()} />}
        {!projects && !projectsFailed && <LoadingRow />}
        {projects?.length === 0 && <EmptyRow title="No projects yet" description="Projects made on this server show here, newest first." />}
        {projects && projects.length > 0 && (
          <div className="overflow-x-auto p-3 sm:p-4">
            <table className={`${tableCls} min-w-[560px]`}>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Project</th>
                  <th className="pb-2 pr-3 font-medium">Owner</th>
                  <th className="pb-2 pr-3 font-medium">Updated</th>
                  <th className="pb-2 pr-3 font-medium">Size</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {[...projects]
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((p) => (
                    <tr key={`${p.kind}:${p.id}`} className="border-t border-border/50 text-foreground/80">
                      <td className="py-2 pr-3">
                        {p.name} <span className="text-muted-foreground">· {p.kind === "captions" ? "Captions" : "Audio"}</span>
                      </td>
                      <td className="py-2 pr-3">{p.owner || "—"}</td>
                      <td className="py-2 pr-3">{fmtAgo(p.updatedAt)}</td>
                      <td className="py-2 pr-3">{fmtBytes(p.bytes)}</td>
                      <td className="py-2 text-right">
                        <Button variant="ghost" size="icon-xs" aria-label={`Delete ${p.name}`} onClick={() => void removeProject(p)}>
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Section>
  );
}

/** Every password sign-in on this server asks for a sign-in code (PUT /api/admin/sign-in-code). */
function AskEveryone() {
  const state = useCodeState();
  if (!state.data) return null;
  const change = async (on: boolean) => {
    if (on && !(await confirmDialog({ title: "Ask everyone for a sign-in code?", body: "Everyone without one is signed out and sets one up at their next sign-in.", ok: "Ask everyone" }))) return;
    const res = await fetch("/api/admin/sign-in-code", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ required: on }) }).catch(() => null);
    const d = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string; required?: boolean };
    if (!res?.ok) return saveFailed(d.error || "It didn't save. Try again.");
    state.set((v) => v && { ...v, required: !!d.required });
  };
  return (
    <Section title="Sign-in">
      <Card>
        <Row
          id="admin-sign-in-code"
          title="Ask everyone for a sign-in code"
          description="Every password sign-in on this server asks for a code from an authenticator app"
          control={<Switch checked={state.data.required} aria-label="Ask everyone for a sign-in code" onCheckedChange={(on) => void change(on)} />}
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
    <FormDialog open={open} onOpenChange={onOpenChange} title="Create account" submitLabel="Create account" busy={busy} error={error} onSubmit={submit}>
      <Input aria-label="Username" placeholder="Username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
      <Input aria-label="Password" placeholder="Password (10+ characters)" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
    <FormDialog open={user !== null} onOpenChange={(o) => !o && onClose()} title={`New password for ${user?.username ?? ""}`} submitLabel="Set password" busy={busy} error={error} onSubmit={() => submit()}>
      <Input aria-label="New password" type="text" placeholder="New password (10+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required />
    </FormDialog>
  );
}

/** One checkbox cell in the Access grid; the whole cell is the click target. */
function Tick({ on, disabled, title, onClick }: { on: boolean; disabled?: boolean; title: string; onClick: () => void }) {
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
