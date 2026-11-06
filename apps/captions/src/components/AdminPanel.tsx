import { Fragment, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  AudioLines,
  Captions,
  Check,
  Copy,
  FolderOpen,
  KeyRound,
  Loader2,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { TOOLS, TOOL_GROUPS, TOOL_NAMES, type Tool } from "@contracts/tools";
import { copySessionToLibrary, flushPendingSave, loadSession } from "@/lib/persist";
import { returnToOwnCaptionView, useAdminView } from "@/lib/admin-view";
import { useStudio } from "@/lib/store";
import { fmtClock } from "@/lib/ass";

/**
 * Admin's tabs, rendered inside Settings → Admin.
 * Users: create/delete accounts,
 * reset passwords, switch each account's apps on or off, and see who
 * actually uses the app (last active, projects, storage, cloud
 * minutes, exports). Projects: every project on the server — the only
 * place other people's work is visible; the personal project list
 * shows just your own. Guests: what guests transcribed (api/guest.ts).
 */

/** Stored as the account's role; Access shows it as two ticks per person:
 *  Admin, and Team (files go 28 days after they last change, a plain
 *  user's after 14; admins keep theirs). */
type Role = "user" | "team" | "admin";

interface AdminUser {
  username: string;
  role: Role;
  off: Tool[];
  createdAt: number;
  usage: {
    logins: number;
    projectsCreated: number;
    cloudRuns: number;
    cloudSeconds: number;
    renders: number;
    lastActiveAt: number;
  };
  projects: number;
  instagramPosts?: number;
  storageBytes: number;
}

interface GuestOverview {
  runs: { at: number; guest: string; file: string; seconds: number; text: string }[];
  today: { seconds: number; ai: number };
  limits: { guestSeconds: number; allSeconds: number; guestAi: number; allAi: number };
}

export type AdminTab = "users" | "access" | "projects" | "guests";


/** Access grid: where a home page section starts, and each section's width. */
const startsGroup = (t: Tool, i: number) =>
  i > 0 && TOOL_GROUPS[TOOLS[i - 1]] !== TOOL_GROUPS[t];
const GROUP_SPANS = TOOLS.reduce<[string, number][]>((acc, t) => {
  const last = acc[acc.length - 1];
  if (last?.[0] === TOOL_GROUPS[t]) last[1]++;
  else acc.push([TOOL_GROUPS[t], 1]);
  return acc;
}, []);

interface AdminProject {
  id: string;
  kind: "captions" | "enhance";
  name: string;
  owner: string; // "" when the project predates accounts
  createdAt: number;
  updatedAt: number;
  duration: number;
  bytes: number;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtCloud(seconds: number, runs: number): string {
  if (!runs) return "—";
  const m = seconds / 60;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min · ${runs}×`;
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
  const navigate = useNavigate();
  const me = useAuth((s) => s.me);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [guests, setGuests] = useState<GuestOverview | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
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
      setError("Could not load users");
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

  useEffect(() => {
    if (tab !== "guests" || guests !== null) return;
    fetch("/api/admin/guests")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setGuests, () => setError("Could not load guests"));
  }, [tab, guests]);

  const call = async (path: string, init: RequestInit) => {
    setError("");
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
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
      body: JSON.stringify({
        username: newName,
        password: newPassword,
      }),
    });
    if (ok) {
      setNewName("");
      setNewPassword("");
    }
    setCreating(false);
  };

  const changeRole = (u: AdminUser, role: Role) =>
    call(`/api/admin/users/${u.username}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });

  const toggleApp = (u: AdminUser, t: Tool) =>
    call(`/api/admin/users/${u.username}`, {
      method: "PATCH",
      body: JSON.stringify({
        off: u.off.includes(t) ? u.off.filter((x) => x !== t) : [...u.off, t],
      }),
    });

  const resetPassword = (u: AdminUser) => {
    const password = window.prompt(
      `New password for "${u.username}" (min 6 chars):`,
    );
    if (!password) return;
    void call(`/api/admin/users/${u.username}`, {
      method: "PATCH",
      body: JSON.stringify({ password }),
    });
  };

  const remove = (u: AdminUser) => {
    if (
      !window.confirm(
        `Delete account "${u.username}" and everything they made? Their projects, original videos, Review videos, notes and guides are deleted for good.`,
      )
    )
      return;
    void call(`/api/admin/users/${u.username}`, { method: "DELETE" });
  };

  const openProject = async (p: AdminProject) => {
    if (opening) return;
    const key = `${p.kind}:${p.id}`;
    const activeAdminView = useAdminView.getState().caption;
    const currentProjectId = useStudio.getState().projectId;
    const currentProject = projects?.find(
      (candidate) =>
        candidate.kind === "captions" && candidate.id === currentProjectId,
    );
    const returnProjectId =
      activeAdminView?.returnProjectId ??
      (currentProject &&
      (!currentProject.owner || currentProject.owner === me?.username)
        ? currentProject.id
        : null);
    setError("");
    setOpening(key);
    let ok = false;
    try {
      await flushPendingSave();
      if (p.kind === "captions") {
        ok = await loadSession(p.id);
      } else {
        ok = await fetch(`/api/enhance/${p.id}`).then((res) => res.ok);
        if (ok) await returnToOwnCaptionView();
      }
    } catch {
      ok = false;
    }

    setOpening(null);
    if (!ok) {
      setError("Could not open project");
      return;
    }

    if (p.kind === "captions") {
      if (p.owner && p.owner !== me?.username) {
        useAdminView.getState().beginCaptionView({
          projectId: p.id,
          owner: p.owner,
          returnProjectId,
        });
      } else {
        useAdminView.getState().clearCaptionView();
      }
    }

    navigate(p.kind === "captions" ? "/captions" : `/enhance/${p.id}`);
  };

  const copyIntoMyProjects = async (p: AdminProject) => {
    if (p.kind !== "captions" || opening || copying) return;
    if (
      !window.confirm(
        `Copy "${p.name}" into your projects? The original stays with ${p.owner || "its owner"}, and the video stays shared on the server.`,
      )
    )
      return;
    const key = `${p.kind}:${p.id}`;
    setError("");
    setCopying(key);
    try {
      await flushPendingSave();
      const copied = await copySessionToLibrary(p.id);
      if (!copied) throw new Error("copy failed");
      const ok = await loadSession(copied.id);
      if (!ok) throw new Error("open failed");
      useAdminView.getState().clearCaptionView();
      navigate("/captions");
    } catch {
      setError("Could not copy this project");
    } finally {
      setCopying(null);
    }
  };

  const removeProject = async (p: AdminProject) => {
    const who =
      p.owner && p.owner !== me?.username ? ` (owner: ${p.owner})` : "";
    const consequence =
      p.kind === "captions"
        ? "It sits in the trash for 5 days, then its original videos and exports are deleted for good."
        : "Its original and enhanced files go too.";
    if (!window.confirm(`Delete project "${p.name}"${who}? ${consequence}`)) {
      return;
    }
    setError("");
    const base = p.kind === "captions" ? "/api/projects" : "/api/enhance";
    const res = await fetch(`${base}/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Delete failed");
      return;
    }
    await refreshProjects();
    void refresh(); // storage/count columns changed
  };

  const projectKind = (p: AdminProject) =>
    p.kind === "captions" ? (
      <span className="flex items-center gap-1.5 text-zinc-400">
        <Captions className="h-3.5 w-3.5 text-violet-400" /> Captions
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-zinc-400">
        <AudioLines className="h-3.5 w-3.5 text-cyan-400" /> Audio
      </span>
    );

  /** Owner cell: name, "(you)", or hints for legacy / deleted accounts. */
  const ownerCell = (p: AdminProject) => {
    if (!p.owner) {
      return <span className="text-zinc-600">— pre-accounts</span>;
    }
    const gone = users !== null && !users.some((u) => u.username === p.owner);
    return (
      <>
        {p.owner}
        {p.owner === me?.username && (
          <span className="ml-1 text-[10px] text-zinc-500">(you)</span>
        )}
        {gone && (
          <span className="ml-1 text-[10px] text-amber-500/80">
            deleted account
          </span>
        )}
      </>
    );
  };

  /** One cell of the Access grid: the whole cell is the click target. */
  const tick = (c: {
    key?: string;
    on: boolean;
    disabled?: boolean;
    divider?: boolean;
    title: string;
    onClick: () => void;
  }) => (
    <td key={c.key} className={c.divider ? "border-l border-zinc-800" : ""}>
      <button
        onClick={c.onClick}
        disabled={c.disabled}
        role="checkbox"
        aria-checked={c.on}
        aria-label={c.title}
        title={c.title}
        className="group flex w-full justify-center py-3 disabled:cursor-default"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
            c.on
              ? "border-violet-500 bg-violet-500 text-white group-enabled:group-hover:bg-violet-400"
              : "border-zinc-600 group-enabled:group-hover:border-zinc-300"
          } ${c.disabled ? "opacity-40" : ""}`}
        >
          {c.on && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      </button>
    </td>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#16161c] p-5 text-zinc-200">
        {tab === "users" && (
          <>
            {users === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="pb-2 pr-3 font-medium">User</th>
                    <th className="pb-2 pr-3 font-medium">Last active</th>
                    <th className="pb-2 pr-3 font-medium">Logins</th>
                    <th className="pb-2 pr-3 font-medium">Projects</th>
                    <th className="pb-2 pr-3 font-medium">Storage</th>
                    <th className="pb-2 pr-3 font-medium">Cloud transcribed</th>
                    <th className="pb-2 pr-3 font-medium">Exports</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.username}
                      className="border-t border-zinc-800 text-zinc-300"
                    >
                      <td className="py-2.5 pr-3">
                        <span className="font-medium text-zinc-200">
                          {u.username}
                        </span>
                        {u.role === "admin" && (
                          <span className="ml-1.5 rounded bg-violet-500/15 px-1 py-px text-[10px] text-violet-300">
                            admin
                          </span>
                        )}
                        {u.username === me?.username && (
                          <span className="ml-1.5 text-[10px] text-zinc-500">
                            (you)
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        {fmtWhen(u.usage.lastActiveAt)}
                      </td>
                      <td className="py-2.5 pr-3">{u.usage.logins || "—"}</td>
                      <td className="py-2.5 pr-3">
                        {u.projects || u.instagramPosts
                          ? `${u.projects || 0}${u.instagramPosts ? ` · ${u.instagramPosts} IG` : ""}`
                          : "—"}
                      </td>
                      <td className="py-2.5 pr-3">
                        {fmtBytes(u.storageBytes)}
                      </td>
                      <td className="py-2.5 pr-3">
                        {fmtCloud(u.usage.cloudSeconds, u.usage.cloudRuns)}
                      </td>
                      <td className="py-2.5 pr-3">{u.usage.renders || "—"}</td>
                      <td className="py-2.5">
                        <span className="flex justify-end gap-1">
                          <button
                            onClick={() => resetPassword(u)}
                            title="Reset password"
                            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </button>
                          {u.username !== me?.username && (
                            <button
                              onClick={() => remove(u)}
                              title="Delete account"
                              className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
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
            )}

            <form
              onSubmit={create}
              className="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-4"
            >
              <UserPlus className="h-4 w-4 shrink-0 text-zinc-500" />
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="username"
                autoCapitalize="none"
                className="w-40 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500"
              />
              <input
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="password (min 6 chars)"
                type="text"
                className="w-48 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={creating || !newName || newPassword.length < 6}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create account"}
              </button>
              {error && <span className="text-xs text-red-400">{error}</span>}
            </form>
            <p className="mt-2 text-[11px] text-zinc-600">
              A new account gets every app,
              and its files are deleted 14 days after they last change (28 for
              Team): change both in Access. Guests (no account) get Caption Studio with AI,
              capped (Guests tab). Share the username and password; they can't
              change it themselves yet.
            </p>
          </>
        )}

        {tab === "access" && (
          <>
            {users === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] table-fixed text-xs">
                  <colgroup>
                    <col className="w-28" />
                    <col />
                    <col />
                    {TOOLS.map((t) => (
                      <col key={t} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                      <th />
                      <th colSpan={2} className="pb-1.5 text-center font-medium">
                        Account
                      </th>
                      {GROUP_SPANS.map(([group, span]) => (
                        <th
                          key={group}
                          colSpan={span}
                          className="border-l border-zinc-800 pb-1.5 text-center font-medium"
                        >
                          {group}
                        </th>
                      ))}
                    </tr>
                    <tr className="text-[11px] leading-tight text-zinc-400">
                      <th className="pb-2 text-left align-bottom text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                        User
                      </th>
                      <th
                        className="px-1 pb-2 text-center align-bottom font-normal"
                        title="Every app, sees all projects, manages users"
                      >
                        Admin
                      </th>
                      <th
                        className="px-1 pb-2 text-center align-bottom font-normal"
                        title="Files are deleted 28 days after they last change (unticked: 14)"
                      >
                        Team
                      </th>
                      {TOOLS.map((t, i) => (
                        <th
                          key={t}
                          className={`px-1 pb-2 text-center align-bottom font-normal ${i === 0 || startsGroup(t, i) ? "border-l border-zinc-800" : ""}`}
                        >
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
                          <tr className="border-t border-zinc-800 hover:bg-zinc-800/30">
                            <td className="truncate py-2 pr-2 font-medium text-zinc-200">
                              {u.username}
                              {you && (
                                <span className="ml-1 text-[10px] font-normal text-zinc-500">
                                  (you)
                                </span>
                              )}
                            </td>
                            {tick({
                              on: admin,
                              disabled: you,
                              title: you
                                ? "You can't change your own admin"
                                : admin
                                  ? `Remove ${u.username} as admin`
                                  : `Make ${u.username} an admin`,
                              onClick: () => {
                                if (
                                  !window.confirm(
                                    admin
                                      ? `Remove ${u.username} as admin? They become Team: their files are deleted 28 days after they last change, anything already older within 6 hours, for good.`
                                      : `Make ${u.username} an admin? Admins get every app, see every project and manage users.`,
                                  )
                                )
                                  return;
                                void changeRole(u, admin ? "team" : "admin");
                              },
                            })}
                            {tick({
                              on: u.role !== "user",
                              disabled: admin,
                              title: admin
                                ? "Admins keep their files"
                                : u.role === "team"
                                  ? `Delete ${u.username}'s files 14 days after they last change`
                                  : `Keep ${u.username}'s files 28 days after they last change`,
                              onClick: () => {
                                if (
                                  u.role === "team" &&
                                  !window.confirm(
                                    `Delete ${u.username}'s files 14 days after they last change? Anything already older goes within 6 hours, for good.`,
                                  )
                                )
                                  return;
                                void changeRole(u, u.role === "team" ? "user" : "team");
                              },
                            })}
                            {TOOLS.map((t, i) => {
                              const on = admin || !u.off.includes(t);
                              return tick({
                                key: t,
                                on,
                                disabled: admin,
                                divider: i === 0 || startsGroup(t, i),
                                title: admin
                                  ? "Admins always have every app"
                                  : `${on ? "Switch off" : "Switch on"} ${TOOL_NAMES[t]} for ${u.username}`,
                                onClick: () => void toggleApp(u, t),
                              });
                            })}
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
            <p className="mt-3 text-[11px] text-zinc-600">
              Every tick saves right away. A new account gets every app, and isn't Team: its files are deleted 14 days
              after they last change (Team: 28 days). Admins keep theirs and have every app.
            </p>
          </>
        )}

        {tab === "projects" && (
          <>
            {projects === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : projects.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                No projects on the server yet.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="pb-2 pr-3 font-medium">Project</th>
                    <th className="pb-2 pr-3 font-medium">Tool</th>
                    <th className="pb-2 pr-3 font-medium">Owner</th>
                    <th className="pb-2 pr-3 font-medium">Last edited</th>
                    <th className="pb-2 pr-3 font-medium">Length</th>
                    <th className="pb-2 pr-3 font-medium">Size</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => {
                    const key = `${p.kind}:${p.id}`;
                    return (
                      <tr
                        key={key}
                        className="border-t border-zinc-800 text-zinc-300"
                      >
                        <td
                          className="max-w-0 py-2.5 pr-3"
                          style={{ width: "30%" }}
                        >
                          <span className="flex items-center gap-2">
                            {p.kind === "captions" ? (
                              <Captions className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                            ) : (
                              <AudioLines className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                            )}
                            <span className="truncate font-medium text-zinc-200">
                              {p.name}
                            </span>
                          </span>
                        </td>
                        <td className="py-2.5 pr-3">{projectKind(p)}</td>
                        <td className="py-2.5 pr-3">{ownerCell(p)}</td>
                        <td className="py-2.5 pr-3">{fmtWhen(p.updatedAt)}</td>
                        <td className="py-2.5 pr-3">
                          {p.duration > 0 ? fmtClock(p.duration) : "—"}
                        </td>
                        <td className="py-2.5 pr-3">{fmtBytes(p.bytes)}</td>
                        <td className="py-2.5">
                          <span className="flex justify-end gap-1">
                            {opening === key ? (
                              <span className="px-1.5 py-1.5 text-[11px] text-violet-400">
                                Opening…
                              </span>
                            ) : copying === key ? (
                              <span className="px-1.5 py-1.5 text-[11px] text-amber-400">
                                Copying…
                              </span>
                            ) : (
                              <>
                                <button
                                  onClick={() => void openProject(p)}
                                  title={`Open in ${
                                    p.kind === "captions"
                                      ? "Caption Studio"
                                      : "Audio Enhancer"
                                  }`}
                                  className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                                >
                                  <FolderOpen className="h-3.5 w-3.5" />
                                </button>
                                {p.kind === "captions" &&
                                  p.owner &&
                                  p.owner !== me?.username && (
                                    <button
                                      onClick={() => void copyIntoMyProjects(p)}
                                      title="Copy to my projects"
                                      className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-amber-300"
                                    >
                                      <Copy className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                <button
                                  onClick={() => void removeProject(p)}
                                  title="Delete project"
                                  className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {projects !== null && projects.length > 0 && (
              <p className="mt-3 border-t border-zinc-800 pt-3 text-[11px] text-zinc-600">
                {projects.length} project{projects.length === 1 ? "" : "s"} ·{" "}
                {projects.filter((p) => p.kind === "captions").length} Caption
                Studio · {projects.filter((p) => p.kind === "enhance").length}{" "}
                Audio Enhancer ·{" "}
                {fmtBytes(projects.reduce((a, p) => a + p.bytes, 0))} on disk.
                Your personal lists show only your own work — this tab is the
                admin view of both tools.
              </p>
            )}
            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          </>
        )}

        {tab === "guests" && (
          <>
            {guests === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : guests.runs.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                No guest has transcribed anything yet.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="pb-2 pr-3 font-medium">When</th>
                    <th className="pb-2 pr-3 font-medium">Guest</th>
                    <th className="pb-2 pr-3 font-medium">Video</th>
                    <th className="pb-2 pr-3 font-medium">Length</th>
                    <th className="pb-2 font-medium">Transcript</th>
                  </tr>
                </thead>
                <tbody>
                  {guests.runs.map((r, i) => (
                    <tr key={i} className="border-t border-zinc-800 align-top text-zinc-300">
                      <td className="whitespace-nowrap py-2.5 pr-3">{fmtWhen(r.at)}</td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-zinc-500">
                        {r.guest.replace(/^guest-?/, "").slice(-6) || "—"}
                      </td>
                      <td className="max-w-0 py-2.5 pr-3" style={{ width: "22%" }}>
                        <span className="block truncate text-zinc-200" title={r.file}>
                          {r.file || "—"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">{fmtClock(r.seconds)}</td>
                      <td className="py-2.5 text-zinc-400">
                        <span className="line-clamp-2" title={r.text}>
                          {r.text || "(no speech)"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {guests !== null && (
              <p className="mt-3 border-t border-zinc-800 pt-3 text-[11px] text-zinc-600">
                Today: {Math.round(guests.today.seconds / 60)} of{" "}
                {guests.limits.allSeconds / 60} guest minutes · {guests.today.ai} of{" "}
                {guests.limits.allAi} AI runs. Each guest: videos up to 3 min,{" "}
                {guests.limits.guestSeconds / 60} min and {guests.limits.guestAi} AI
                runs a day. Guests' AI runs on the API key only when it is switched
                on in AI providers. Counts reset at midnight UTC and on a server restart.
              </p>
            )}
            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          </>
        )}
    </div>
  );
}
