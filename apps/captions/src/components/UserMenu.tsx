import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ChevronDown,
  Eye,
  BarChart3,
  Download,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { isGuest, logout, useAuth } from "@/lib/auth";
import { getWorkspace } from "@/lib/workspaces";
import { isPhoneHub } from "@/lib/mobile";
import { isPublicReviewPath, isPublicSharePath } from "./AuthGate";
import { useMacRelease } from "./MacAppDownload";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * Account menu for the current identity. Admin management, role preview,
 * and sign-out live together here instead of competing header buttons.
 */
/**
 * Where CornerNav shows (signed in, not a guest, not a phone or a public page), the account menu sits there, bottom
 * left, the one button there; elsewhere it stays top right.
 */
export function useAccountInCorner(): boolean {
  const me = useAuth((s) => s.me);
  const { pathname } = useLocation();
  return (
    !!me && !isGuest(me) && !isPhoneHub() && !pathname.startsWith("/m") &&
    !isPublicSharePath(pathname) && !isPublicReviewPath(pathname)
  );
}

/** The bell and (unless it sits in the corner) the account menu; `corner` = the menu alone, opening upward. */
export function UserMenu({ corner = false }: { corner?: boolean } = {}) {
  const required = useAuth((s) => s.required);
  const me = useAuth((s) => s.me);
  const viewAs = useAuth((s) => s.viewAs);
  const navigate = useNavigate();
  const inCorner = useAccountInCorner();
  const release = useMacRelease();
  // the team role, read when the menu opens: "Owner · Workspace" (never the server-operator role)
  const [team, setTeam] = useState<string | null>(null);

  if (!me) return null;
  // no bell: the inbox stays on the server for the Mac app's notifications
  if (!corner && inCorner) return null;

  return (
    <span className="flex items-center gap-0.5">
      <DropdownMenu onOpenChange={(open) => open && !me.demo && me.role !== "guest" && void getWorkspace().then((v) => setTeam(v ? `${v.me === "owner" ? "Owner" : "Member"} · ${v.workspace.name}` : null)).catch(() => {})}>
        <DropdownMenuTrigger asChild>
          <button
            title="Account menu"
            className={`flex h-7 items-center gap-2 rounded-md border pl-1 pr-2.5 text-xs outline-none transition-colors hover:bg-accent data-[state=open]:bg-accent ${
              viewAs
                ? "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-100"
                : "border-border text-foreground"
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded ${
                me.role === "admin" ? "bg-violet-600/25" : "bg-muted"
              }`}
            >
              {viewAs ? (
                <Eye className="h-3.5 w-3.5 text-fuchsia-600 dark:text-fuchsia-300" />
              ) : me.role === "admin" ? (
                <ShieldCheck className="h-3.5 w-3.5 text-violet-600 dark:text-violet-300" />
              ) : (
                <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </span>
            <span className="hidden max-w-28 truncate sm:inline">{me.username}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={corner ? "top" : "bottom"} align={corner ? "start" : "end"} className="w-64">
          <DropdownMenuLabel className="px-2 py-2 font-normal">
            <span className="block truncate text-xs font-medium text-foreground">
              {me.username}
            </span>
            <span className="mt-0.5 block text-[10px] tracking-wider text-muted-foreground">
              {me.role === "guest" ? "Guest" : team}
            </span>
          </DropdownMenuLabel>

          {/* one account button: your own Settings and Usage,
              the platform's Admin for its admins (Team sits in Settings), the Mac app, sign out */}
          {!me.demo && me.role !== "guest" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/settings")} className="text-xs">
                <Settings /> Settings
                <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/settings/usage")} className="text-xs">
                <BarChart3 /> Usage
              </DropdownMenuItem>
              {release && !document.documentElement.classList.contains("mac-app") && (
                <DropdownMenuItem asChild className="text-xs">
                  <a href="/api/mac-app/download">
                    <Download /> Get the Mac app
                  </a>
                </DropdownMenuItem>
              )}
            </>
          )}

          {required && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void logout()}
                className="text-xs text-muted-foreground"
              >
                <LogOut /> Sign out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
