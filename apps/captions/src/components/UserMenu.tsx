import { useLocation, useNavigate } from "react-router";
import {
  ChevronDown,
  BarChart3,
  Globe,
  LogOut,
  Settings,
  UserRound,
} from "lucide-react";
import { logout, useAuth } from "@/lib/auth";
import { isPhoneHub } from "@/lib/mobile";
import { isPublicReviewPath, isPublicSharePath } from "./AuthGate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Where CornerNav shows (signed in, not a phone or a public page). */
export function useAccountInCorner(): boolean {
  const me = useAuth((s) => s.me);
  const { pathname } = useLocation();
  return (
    !!me && !isPhoneHub() && !pathname.startsWith("/m") &&
    !isPublicSharePath(pathname) && !isPublicReviewPath(pathname)
  );
}

/** The account menu, top right beside the project switcher: Settings, Community, Usage, the Mac app, sign out. */
export function UserMenu() {
  const required = useAuth((s) => s.required);
  const me = useAuth((s) => s.me);
  const navigate = useNavigate();

  if (!me) return null;

  return (
    <span className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            title="Account menu"
            className="flex h-7 items-center gap-2 rounded-md border border-border pl-1 pr-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent data-[state=open]:bg-accent"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded bg-muted">
              <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
            <span className="hidden max-w-28 truncate sm:inline">{me.username}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="px-2 py-2 font-normal">
            <span className="block truncate text-xs font-medium text-foreground">
              {me.username}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/settings")} className="text-xs">
            <Settings /> Settings
            <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/community")} className="text-xs">
            <Globe /> Community
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/settings/usage")} className="text-xs">
            <BarChart3 /> Usage
          </DropdownMenuItem>

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
