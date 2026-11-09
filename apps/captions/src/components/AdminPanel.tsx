import { Fragment, useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Trash2, UserPlus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { TOOLS, TOOL_NAMES, type Tool } from "@contracts/tools";
import { Card, Footnote, Group, Loading } from "@/components/settings/ui";
import { inputCls } from "@/components/settings/helpers";
import { Button } from "@/components/ui/button";

/**
 * Settings → Admin (hosted servers only; platform admins only): the accounts on this server, the apps each one gets,
 * and every project on the server. Admin API: api/admin.ts. Not here yet: the Mac app sign-ups list and the Media
 * Library's presets (both need their own server routes).
 */

/** Stored as the account's role: Admin, Team (files kept 28 days after they last change, a plain user's 14), or user. */
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

export function AdminPanel({ tab }: { tab: AdminTab }) {
  const me = useAuth((s) => s.me);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error();
      setUsers(await res.json());
    } catch {
      setError("Could not load accounts");
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/projects");
      if (!res.ok) throw new Error();
      setProjects(await res.json());
    } catch {
      setError("Could not load projects");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab === "projects" && projects === null) void refreshProjects();
  }, [tab, projects, refreshProjects]);

  const call = async (path: string, init: RequestInit) => {
    setError("");
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Request failed");
      return false;
    }
    await refresh();
    return true;
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    const ok = await call("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: newName, password: newPassword }),
    });
    if (ok) {
      setNewName("");
      setNewPassword("");
    }
    setCreating(false);
  };

  const changeRole = (u: AdminUser, role: Role) =>
    call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ role }) });

  const toggleApp = (u: AdminUser, t: Tool) =>
    call(`/api/admin/users/${u.username}`, {
      method: "PATCH",
      body: JSON.stringify({ off: u.off.includes(t) ? u.off.filter((x) => x !== t) : [...u.off, t] }),
    });

  const resetPassword = (u: AdminUser) => {
    const password = window.prompt(`New password for "${u.username}" (min 6 chars):`);
    if (!password) return;
    void call(`/api/admin/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ password }) });
  };

  const remove = (u: AdminUser) => {
    if (!window.confirm(`Delete account "${u.username}"? It leaves its team and loses its library grants. Its files stay on the server for now.`)) return;
    void call(`/api/admin/users/${u.username}`, { method: "DELETE" });
  };

  const removeProject = async (p: AdminProject) => {
    const who = p.owner && p.owner !== me?.username ? ` (owner: ${p.owner})` : "";
    if (!window.confirm(`Delete project "${p.name}"${who}?`)) return;
    setError("");
    const base = p.kind === "captions" ? "/api/projects" : "/api/enhance";
    const res = await fetch(`${base}/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Delete failed");
      return;
    }
    await refreshProjects();
    void refresh();
  };

  if (tab === "users") {
    return (
      <>
        <Group title="Accounts" hint="Create accounts, reset passwords, and see what each one uses.">
          <Card>
            {users === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="overflow-x-auto p-3 sm:p-4">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">Account</th>
                      <th className="pb-2 pr-3 font-medium">Last active</th>
                      <th className="pb-2 pr-3 font-medium">Logins</th>
                      <th className="pb-2 pr-3 font-medium">Projects</th>
                      <th className="pb-2 pr-3 font-medium">Storage</th>
                      <th className="pb-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.username} className="border-t border-border/50 text-foreground/80">
                        <td className="py-2.5 pr-3">
                          <span className="font-medium text-foreground">{u.name || u.username}</span>
                          {u.role === "admin" && (
                            <span className="ml-1.5 rounded bg-violet-500/15 px-1 py-px text-[10px] text-violet-600 dark:text-violet-300">admin</span>
                          )}
                          {u.username === me?.username && <span className="ml-1.5 text-[10px] text-muted-foreground">(you)</span>}
                        </td>
                        <td className="py-2.5 pr-3">{fmtWhen(u.usage.lastActiveAt)}</td>
                        <td className="py-2.5 pr-3">{u.usage.logins || "—"}</td>
                        <td className="py-2.5 pr-3">
                          {u.projects || u.instagramPosts ? `${u.projects || 0}${u.instagramPosts ? ` · ${u.instagramPosts} IG` : ""}` : "—"}
                        </td>
                        <td className="py-2.5 pr-3">{fmtBytes(u.storageBytes)}</td>
                        <td className="py-2.5">
                          <span className="flex justify-end gap-1">
                            <button
                              onClick={() => resetPassword(u)}
                              title="Reset password"
                              aria-label={`Reset ${u.username}'s password`}
                              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </button>
                            {u.username !== me?.username && (
                              <button
                                onClick={() => remove(u)}
                                title="Delete account"
                                aria-label={`Delete ${u.username}`}
                                className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-red-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form onSubmit={create} className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
              <UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="username" autoCapitalize="none" className={`${inputCls} w-40`} />
              <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="password (min 6 chars)" type="text" className={`${inputCls} w-48`} />
              <Button type="submit" size="sm" disabled={creating || !newName || newPassword.length < 6}>
                {creating ? "Creating…" : "Create account"}
              </Button>
              {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
            </form>
          </Card>
          <Footnote>New accounts get every app. Files are not deleted by age on this server yet.</Footnote>
        </Group>
      </>
    );
  }

  if (tab === "access") {
    return (
      <Group title="Access" hint="Every tick saves right away.">
        {users === null ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <Card>
            <div className="overflow-x-auto p-3 sm:p-4">
              <table className="w-full min-w-[640px] text-xs">
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
                            onClick={() => {
                              if (!window.confirm(admin ? `Remove ${u.username} as admin?` : `Make ${u.username} an admin? Admins see every project and manage accounts.`)) return;
                              void changeRole(u, admin ? "team" : "admin");
                            }}
                          />
                          <Tick
                            on={u.role === "team" || admin}
                            disabled={admin}
                            title={`${u.username} is a team account (files kept 28 days)`}
                            onClick={() => void changeRole(u, u.role === "team" ? "user" : "team")}
                          />
                          {TOOLS.map((t) => (
                            <Tick
                              key={t}
                              on={admin || !u.off.includes(t)}
                              disabled={admin}
                              title={`${TOOL_NAMES[t]} for ${u.username}`}
                              onClick={() => void toggleApp(u, t)}
                            />
                          ))}
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Group>
    );
  }

  return (
    <Group title="Projects" hint="Every project on this server, newest first.">
      <Card>
        {projects === null ? (
          <Loading />
        ) : projects.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No projects yet.</p>
        ) : (
          <div className="overflow-x-auto p-3 sm:p-4">
            <table className="w-full text-left text-xs">
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
                        <button
                          onClick={() => void removeProject(p)}
                          aria-label={`Delete ${p.name}`}
                          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {error && <p className="pt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}
      </Card>
    </Group>
  );
}

/** One checkbox cell in the Access grid; the whole cell is the click target. */
function Tick({ on, disabled, title, onClick }: { on: boolean; disabled?: boolean; title: string; onClick: () => void }) {
  return (
    <td>
      <button
        onClick={onClick}
        disabled={disabled}
        role="checkbox"
        aria-checked={on}
        aria-label={title}
        title={title}
        className="group flex w-full justify-center py-3 disabled:cursor-default"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
            on
              ? "border-violet-600 bg-violet-600 text-white group-enabled:group-hover:bg-violet-500"
              : "border-muted-foreground/50 group-enabled:group-hover:border-muted-foreground"
          } ${disabled ? "opacity-40" : ""}`}
        >
          {on && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      </button>
    </td>
  );
}
