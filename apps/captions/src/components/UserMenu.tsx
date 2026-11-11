import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ChevronDown,
  BarChart3,
  Check,
  Globe,
  Laptop,
  LogOut,
  Plus,
  Server,
  Settings,
  UserRound,
} from "lucide-react";
import { logout, useAuth } from "@/lib/auth";
import { isPhoneHub } from "@/lib/mobile";
import { accountItemsFor } from "@/lib/plugin";
import { AccountAvatar } from "@/components/settings/AccountSection";
import { hasThisMac, useThisMac } from "@/components/settings/ThisMacSection";
import { switchServer } from "@/components/settings/ServersSection";
import { webPlugins } from "@/plugins.gen";
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

/**
 * The account menu, top right beside the project switcher: in the Mac app the servers it opens (pick one to switch),
 * then Settings, Community, Usage, the plug-ins' items, sign out. A team lives on its server, so the servers are the teams.
 */
export function UserMenu() {
  const required = useAuth((s) => s.required);
  const me = useAuth((s) => s.me);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // the app's servers, asked only while the menu is open (its last answer paints at once)
  const mac = useThisMac(open && hasThisMac());
  const servers = mac?.servers ?? [];
  const current = servers.find((v) => v.current);

  if (!me) return null;
  const pluginItems = accountItemsFor(me, webPlugins);

  return (
    <span className="flex items-center gap-0.5">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            title="Account menu"
            className="flex h-7 items-center gap-2 rounded-md border border-border pl-1 pr-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent data-[state=open]:bg-accent"
          >
            <AccountAvatar
              picture={me.picture}
              initial=""
              className="h-5 w-5"
              fallback={
                <span className="flex h-5 w-5 items-center justify-center rounded bg-muted">
                  <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              }
            />
            <span className="hidden max-w-28 truncate sm:inline">{me.name ?? me.username}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="px-2 py-2 font-normal">
            <span className="block truncate text-xs font-medium text-foreground">
              {me.name ?? me.username}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {mac && (
            <>
              <DropdownMenuLabel className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                Servers
              </DropdownMenuLabel>
              {servers.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onSelect={() => { if (!v.current) void switchServer(v, current); }}
                  className="text-xs"
                >
                  {v.id === "this-mac" ? <Laptop /> : <Server />}
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  {v.current && <Check className="text-foreground" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => navigate("/settings/servers?add=1")} className="text-xs text-muted-foreground">
                <Plus /> Add server
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
          {pluginItems.map((item) => (
            <DropdownMenuItem key={item.to} onSelect={() => navigate(item.to)} className="text-xs">
              <item.icon /> {item.label}
            </DropdownMenuItem>
          ))}

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
