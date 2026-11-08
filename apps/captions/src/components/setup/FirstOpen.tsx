import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { NEED_SHORT, readiness, TOOL_NAMES, type Need, type Tool } from "@contracts/tools";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth";
import { showAssistantNotice, useAssistant } from "@/lib/assistant";
import { openSetupAt, toolForPath, useSetup, useSetupLive, useWorkTalk } from "@/lib/setup";
import { ToolNeeds } from "./ToolNeeds";

const seen = (user: string, tool: Tool) => `ct-first-open:${user}:${tool}`;

/** "an Apify key and a Deepgram key" (8.3): the short names of the missing required rows, joined. */
function joinNeeds(needs: readonly Need[]): string {
  const names = needs.map((n) => NEED_SHORT[n.anyOf[0]]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The text the chat path copies (8.2): the same request the assistant's chip sends. */
const walkText = (tool: Tool) => `Walk me through setting up ${TOOL_NAMES[tool]}, one step at a time.`;

/**
 * The first time a tool the person ticked opens with something it needs missing, a gentle welcome shows over it, once
 * per tool on this device (8.1). The tool's own "Set up" line opens the same card any time (openToolSetup).
 */
export function FirstOpen() {
  const me = useMe();
  const real = !!me;
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const { talk } = useWorkTalk();
  const connected = useAssistant((s) => s.connected);
  const [shown, setShown] = useState<Tool | null>(null);
  const [note, setNote] = useState(false);
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
  // "Not now" says where to come back, for four seconds, after the card has closed
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(false), 4000);
    return () => window.clearTimeout(t);
  }, [note]);
  useSetupLive(!!shown);

  const toast = note && (
    <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 shadow-lg">
      You can come back to this from the tool's page.
    </div>
  );
  if (!shown || !view) return toast || null;

  const r = readiness(shown, view.have);
  const close = () => setShown(null);
  const notReady = !r.ready;
  const copy = walkText(shown);

  const fullSetup = () => {
    close();
    navigate("/settings/setup");
  };
  const askAssistant = () => {
    const needs = joinNeeds(r.missing);
    showAssistantNotice({
      text: `${TOOL_NAMES[shown]} still needs ${needs}. Tap Walk me through it, and I'll go through each one with you, one step at a time.`,
      chip: { label: "Walk me through it", send: copy },
    });
    close();
  };
  const connectAi = () => {
    close();
    openSetupAt("ai");
  };
  const later = () => {
    close();
    setNote(true);
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && later()}>
        <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] w-[min(720px,calc(100vw-2rem))] max-w-none overflow-y-auto sm:max-w-none">
          <DialogTitle>{TOOL_NAMES[shown]}</DialogTitle>
          {notReady ? (
            <DialogDescription>{`You can use ${TOOL_NAMES[shown]}, but it still needs a few things.`}</DialogDescription>
          ) : (
            <DialogDescription>Ready. These add more, all optional.</DialogDescription>
          )}
          <ToolNeeds tool={shown} have={view.have} title={false} welcome={notReady} />

          {notReady && talk === "chat" && (
            <div className="mb-3">
              <label htmlFor="ct-walk-copy" className="text-xs text-muted-foreground">Copy a question for your AI</label>
              <div className="mt-1 flex gap-2">
                <textarea id="ct-walk-copy" readOnly value={copy} rows={2} className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(copy)}>Copy</Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {notReady ? (
              <>
                <Button size="sm" variant="ghost" onClick={later}>Not now</Button>
                <Button size="sm" variant="outline" onClick={fullSetup}>Open full setup</Button>
                {talk !== "chat" && (
                  connected ? (
                    <Button size="sm" variant="outline" onClick={askAssistant}>Ask the assistant</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={connectAi}>Connect your AI</Button>
                  )
                )}
              </>
            ) : (
              <Button size="sm" onClick={close}>Done</Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {toast}
    </>
  );
}
