import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, saveFailed } from "@/components/settings/ui";
import { msg } from "@/components/settings/helpers";

/**
 * Settings → Admin (hosted servers, platform admins only): accounts, the apps each one gets (Access), and every project on
 * the server. Admin API: api/admin.ts. Ticks in Access save at once; a failed save is a toast and the grid keeps the
 * saved state.
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

const ROLE_NAME: Record<Role, string> = { admin: "Admin", team: "Team member (files kept 28 days)", user: "Member" };

function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtWhen(ts: number): string {
  if (!ts) return "never";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  if (d < 7 * 86400_000) return `${Math.round(d / 86400_000)} d ago`;
  return new Date(ts).toLocaleDateString();
}

const tableCls = "w-full text-left text-xs";

export function AdminPanel({ tab }: { tab: AdminTab }) {
  const me = useAuth((s) => s.me);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error();
      setUsers(await res.json());
      setLoadError(null);
    } catch {
      setLoadError("The accounts did not load.");
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/projects");
      if (!res.ok) throw new Error();
      setProjects(await res.json());
      setLoadError(null);
    } catch {
      setLoadError("The projects did not load.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab === "projects" && projects === null) void refreshProjects();
  }, [tab, projects, refreshProjects]);

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

  const toggleApp = (u: AdminUser, t: Tool) =>
    attempt(call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ off: u.off.includes(t) ? u.off.filter((x) => x !== t) : [...u.off, t] }) }));
  const changeRole = (u: AdminUser, role: Role) => attempt(call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ role }) }));
  const removeAccount = (u: AdminUser) => attempt(call(`/api/admin/users/${u.username}`, { method: "DELETE" }));
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
              + Create account
            </Button>
          }
        >
          <Card>
            {loadError && <ErrorRow title={loadError} retry={() => void refresh()} />}
            {!loadError && users === null && <LoadingRow />}
            {users?.length === 0 && <EmptyRow title="No accounts yet" />}
            {users?.map((u) => {
              const you = u.username === me?.username;
              const admin = u.role === "admin";
              const parts = [
                ROLE_NAME[u.role],
                `last active ${fmtWhen(u.usage.lastActiveAt)}`,
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
                          admin
                            ? { label: "Remove admin", confirm: { title: `Remove ${u.username} as admin?`, ok: "Remove admin" }, onSelect: () => changeRole(u, "team") }
                            : { label: "Make admin", confirm: { title: `Make ${u.username} an admin?`, body: "Admins see every project and manage accounts.", ok: "Make admin" }, onSelect: () => changeRole(u, "admin") },
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
        <CreateAccount open={creating} onOpenChange={setCreating} onCreated={() => void refresh()} />
        <ResetPassword user={resetFor} onClose={() => setResetFor(null)} call={call} />
      </>
    );
  }

  if (tab === "access") {
    return (
      <Section id="admin-access" title="Access">
        <Card>
          {loadError && <ErrorRow title={loadError} retry={() => void refresh()} />}
          {!loadError && users === null && <LoadingRow />}
          {users && (
            <div className="overflow-x-auto p-3 sm:p-4">
              <table className={`${tableCls} min-w-[640px]`}>
                <thead>
                  <tr className="text-[11px] leading-tight text-muted-foreground">
                    <th className="pb-2 text-left align-bottom text-[10px] font-medium uppercase tracking-wider">Account</th>
                    <th className="px-1 pb-2 text-center align-bottom font-normal" title="Every app, sees all projects, manages accounts">
                      Admin
                    </th>
                    <th className="px-1 pb-2 text-center align-bottom font-normal" title="Files are kept 28 days after they last change (unticked: 14)">
                      Team
                    </th>
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
                          <td className="truncate py-2 pr-2 font-medium text-foreground">
                            {u.username}
                            {you && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(you)</span>}
                          </td>
                          <Tick
                            on={admin}
                            disabled={you}
                            title={you ? "You can't change your own admin" : admin ? `Remove ${u.username} as admin` : `Make ${u.username} an admin`}
                            onClick={async () => {
                              const ok = await confirmDialog({
                                title: admin ? `Remove ${u.username} as admin?` : `Make ${u.username} an admin?`,
                                body: admin ? undefined : "Admins see every project and manage accounts.",
                                ok: admin ? "Remove admin" : "Make admin",
                              });
                              if (ok) void changeRole(u, admin ? "team" : "admin");
                            }}
                          />
                          <Tick
                            on={u.role === "team" || admin}
                            disabled={admin}
                            title={`${u.username} is a team account (files kept 28 days)`}
                            onClick={() => void changeRole(u, u.role === "team" ? "user" : "team")}
                          />
                          {TOOLS.map((t) => (
                            <Tick key={t} on={admin || !u.off.includes(t)} disabled={admin} title={`${TOOL_NAMES[t]} for ${u.username}`} onClick={() => void toggleApp(u, t)} />
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
        {loadError && <ErrorRow title={loadError} retry={() => void refreshProjects()} />}
        {!loadError && projects === null && <LoadingRow />}
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
                      <td className="py-2 pr-3">{fmtWhen(p.updatedAt)}</td>
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

/** Makes an account: a username and a password of at least six characters (api/admin.ts POST /users). */
function CreateAccount({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (password.length < 6) return setError("The password needs at least 6 characters.");
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
      <Input aria-label="Password" placeholder="Password (6+ characters)" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
    if (password.length < 6) return setError("The password needs at least 6 characters.");
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
      <Input aria-label="New password" type="text" placeholder="New password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
