import { Navigate } from "react-router";

/**
 * There is no Admin page any more (owner, 2026-11-14: "admin and team are like mixed up and weird"). Its tabs live where
 * their settings belong: Accounts and Access in Team, Projects in Storage, Server keys in API keys, a plug-in's tab on its
 * own page in the Plug-ins block. This sends each old address there.
 */
const MOVED: Record<string, string> = {
  users: "/settings/team",
  access: "/settings/team",
  apps: "/settings/team",
  projects: "/settings/folders",
  "server-keys": "/settings/keys",
  ai: "/settings/keys",
};

/** Where /settings/admin/<sub> goes now: a built-in tab's new page, else the plug-in page of that id (else Team). */
export const adminMovedTo = (sub: string | undefined): string => (sub ? (MOVED[sub] ?? `/settings/${sub}`) : "/settings/team");

export function AdminSection({ sub }: { sub?: string }) {
  return <Navigate to={adminMovedTo(sub)} replace />;
}
