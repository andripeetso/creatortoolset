import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { NEED_SHORT, readiness, TOOL_NAMES, type Have, type Need, type Tool } from "@contracts/tools";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth";
import { showAssistantNotice, useAssistant } from "@/lib/assistant";
import { openSetupAt, toolForPath, useSetup, useSetupLive, useSetupShown, useWorkTalk } from "@/lib/setup";
import { ToolNeeds } from "./ToolNeeds";

/** "an Apify key and a Deepgram key" (8.3): the short names of the missing required rows, joined. */
function joinNeeds(needs: readonly Need[]): string {
  const names = needs.map((n) => NEED_SHORT[n.anyOf[0]]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The text the chat path copies (8.2): the same request the assistant's chip sends. */
const walkText = (tool: Tool) => `Walk me through setting up ${TOOL_NAMES[tool]}, one step at a time.`;

/**
 * A tool that still needs something opens with its checklist over it, every time it is opened, until it is set up
 * (owner, 2026-11-10: the card, not a line of text on the page). Not now closes it for that visit: moving around inside
 * the tool doesn't bring it back, leaving and coming back does. Home's amber dot says the same thing before the click.
 * openToolSetup opens the same card from anywhere.
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
  const [dismissed, setDismissed] = useState<Tool | null>(null); // closed for this visit to that tool
  const tool = toolForPath(pathname);
  // the setup window is up: asked for by a link, or by itself on a first run (which has no link). The card waits for it
  const setupUp = useSetupShown((s) => s.shown);
  const inSetup = params.has("setup") || setupUp;

  useEffect(() => {
    if (real && !view) void load();
  }, [real, view, load]);
  useEffect(() => {
    const ask = (e: Event) => setShown((e as CustomEvent<Tool>).detail);
    window.addEventListener("ct-tool-setup", ask);
    return () => window.removeEventListener("ct-tool-setup", ask);
  }, []);
  // leaving the tool forgets its Not now: the next visit opens the card again
  useEffect(() => {
    setDismissed((d) => (d === tool ? d : null));
  }, [tool]);
  useEffect(() => {
    if (opensCard({ real, inSetup, tool, view, dismissed })) setShown(tool);
  }, [real, inSetup, tool, view, dismissed]);
  useSetupLive(!!shown);

  // never over the setup window: a card that was already up waits behind it and shows when setup closes
  if (!shown || !view || setupUp) return null;

  const r = readiness(shown, view.have);
  const close = () => {
    setDismissed(shown);
    setShown(null);
  };
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
    openSetupAt("agents");
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && close()}>
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
                <Button size="sm" variant="ghost" onClick={close}>Not now</Button>
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
    </>
  );
}

/**
 * Whether opening `tool` brings its checklist up: a signed-in person, outside the setup window, on a tool that is one of
 * theirs (the same test as Home's amber dot: every tool until they picked some) and still misses something it needs,
 * unless they closed the card on this visit. Pure, for tests.
 */
export function opensCard(s: { real: boolean; inSetup: boolean; tool: Tool | null; view: { tools: Tool[] | null; have: Iterable<Have> } | null; dismissed: Tool | null }): s is typeof s & { tool: Tool } {
  if (!s.real || s.inSetup || !s.tool || !s.view || s.dismissed === s.tool) return false;
  if (s.view.tools && !s.view.tools.includes(s.tool)) return false;
  return !readiness(s.tool, s.view.have).ready;
}
