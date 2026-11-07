import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { readiness, TOOL_NAMES, type Tool } from "@contracts/tools";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isDemo, isGuest, useViewedMe } from "@/lib/auth";
import { toolForPath, useSetup, useSetupLive } from "@/lib/setup";
import { ToolNeeds } from "./ToolNeeds";

const seen = (user: string, tool: Tool) => `ct-first-open:${user}:${tool}`;

/**
 * The first time a tool the person ticked opens with something it needs missing, its checklist (TOOL_NEEDS) shows
 * over it, once per tool on this device. A tool's own "Set up" link opens it again any time (openToolSetup).
 */
export function FirstOpen() {
  const me = useViewedMe();
  const real = !!me && !isGuest(me) && !isDemo(me);
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const [shown, setShown] = useState<Tool | null>(null);
  const tool = toolForPath(pathname);
  const inSetup = params.has("setup");

  useEffect(() => {
    if (real && !view) void load();
  }, [real, view, load]);
  useEffect(() => {
    const ask = (e: Event) => setShown((e as CustomEvent<Tool>).detail);
    window.addEventListener("ct-tool-setup", ask);
    return () => window.removeEventListener("ct-tool-setup", ask);
  }, []);
  useEffect(() => {
    if (!real || inSetup || !tool || !view?.tools?.includes(tool) || readiness(tool, view.have).ready) return;
    try {
      if (localStorage.getItem(seen(me.username, tool))) return;
      localStorage.setItem(seen(me.username, tool), "1");
    } catch {
      return; // no storage: never shown by itself rather than on every open
    }
    setShown(tool);
  }, [real, inSetup, tool, view, me]);
  useSetupLive(!!shown);

  if (!shown || !view) return null;
  const ready = readiness(shown, view.have).ready;
  return (
    <Dialog open onOpenChange={(o) => !o && setShown(null)}>
      <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] w-[min(720px,calc(100vw-2rem))] max-w-none overflow-y-auto sm:max-w-none">
        <DialogTitle>{TOOL_NAMES[shown]}</DialogTitle>
        <DialogDescription>{ready ? "Ready. These add more, all optional." : "Before you start: what this tool needs. Each provider bills you directly."}</DialogDescription>
        <ToolNeeds tool={shown} have={view.have} title={false} />
        <div className="flex justify-end">
          <Button size="sm" variant={ready ? "default" : "outline"} onClick={() => setShown(null)}>
            {ready ? "Done" : "Later"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
