import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LIBRARY_SETUP_DONE, LIBRARY_WORDS, type ActionNeeded } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { useLibraryChanges } from "@/lib/library";
import { thisMacDevice } from "@/lib/providers";
import { chooseFolderOnMac, thisMacBridge } from "@/lib/thisMac";

/** Whether any library in the list is set up (setupAt, the library page's save; GET /api/library). */
export const setUpIn = (libraries: { settings: { setupAt?: string } }[]): boolean => libraries.some((l) => !!l.settings?.setupAt);

/**
 * The card under a reply whose tool needs the person first (ActionNeeded, contracts/library.ts): the Media Library's
 * setup (its owner sets it up on the page; a member gets no button) or the Downloads switch. The ask it stopped on
 * goes on by itself, once: when the library of its workspace is set up (LIBRARY_SETUP_DONE), or after Turn on.
 */
/** Whether a LIBRARY_SETUP_DONE for `workspace` is the one a setup card waits on. */
export const resumesOn = (action: ActionNeeded, workspace: string): boolean => action.kind === "setup" && action.workspace === workspace;

export function ActionCard({ action, ask, onContinue }: { action?: ActionNeeded; ask?: string; onContinue?: (text: string) => void }) {
  const navigate = useNavigate();
  const [turned, setTurned] = useState<"busy" | "on" | "failed" | null>(null);
  const continued = useRef(false);

  // the library page saves the setup and the change stream says the library changed: then the list says whether it is set up
  useLibraryChanges(() => {
    if (action?.kind !== "setup" || !ask || continued.current) return;
    void fetch("/api/library")
      .then((r) => (r.ok ? (r.json() as Promise<{ libraries: { settings: { setupAt?: string } }[] }>) : null))
      .then((b) => {
        if (b && setUpIn(b.libraries)) window.dispatchEvent(new CustomEvent(LIBRARY_SETUP_DONE, { detail: { workspace: action.workspace } }));
      })
      .catch(() => undefined);
  });

  useEffect(() => {
    if (action?.kind !== "setup" || !ask) return;
    const onDone = (e: Event) => {
      if (!resumesOn(action, (e as CustomEvent<{ workspace?: string }>).detail?.workspace ?? "")) return;
      if (!continued.current) onContinue?.(ask);
      continued.current = true;
    };
    window.addEventListener(LIBRARY_SETUP_DONE, onDone);
    return () => window.removeEventListener(LIBRARY_SETUP_DONE, onDone);
  }, [action, ask, onContinue]);

  if (!action) return null;

  if (action.kind === "setup") {
    return (
      <div className="my-1.5 flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
        <p>{action.owner ? LIBRARY_WORDS.setupCard(action.workspaceName) : LIBRARY_WORDS.setupCardMember}</p>
        {action.owner && (
          <Button size="sm" onClick={() => navigate(action.href)}>
            {LIBRARY_WORDS.setupButton}
          </Button>
        )}
      </div>
    );
  }

  if (action.kind === "projects") return <ProjectsCard action={action} />;

  const turnOn = async () => {
    setTurned("busy");
    const r = await fetch("/api/library/offline/downloads", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ library: action.libraryId, mode: "needed" }),
    }).catch(() => null);
    if (!r?.ok) return setTurned("failed");
    setTurned("on");
    if (ask && !continued.current) {
      continued.current = true;
      onContinue?.(LIBRARY_WORDS.downloadsDone(ask));
    }
  };

  // once it is on, the chat has gone on with the ask: the card has nothing left to say
  if (turned === "on") return null;
  return (
    <div className="my-1.5 flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
      <p>{LIBRARY_WORDS.downloadsCard}</p>
      <Button size="sm" disabled={turned === "busy"} onClick={() => void turnOn()}>
        {LIBRARY_WORDS.downloadsButton}
      </Button>
      {turned === "failed" && <p className="text-xs text-destructive">Could not turn it on. Try again.</p>}
    </div>
  );
}

/** The Project files row for the workspace on the computer doing the work, through Settings → Folders' own request. */
export async function addProjectsFolder(action: Extract<ActionNeeded, { kind: "projects" }>, path: string): Promise<boolean> {
  const r = await fetch("/api/devices/storage/folders", {
    method: "POST",
    headers: { "content-type": "application/json", "X-CT-Workspace": action.workspace },
    body: JSON.stringify({ role: "projects", host: action.device, path }),
  }).catch(() => null);
  // already there (a second tap, another window): what the card asked for
  return !!r && (r.ok || /already/i.test(((await r.json().catch(() => ({}))) as { error?: string }).error ?? ""));
}

/**
 * An edit waits for the workspace's Project files folder (contracts/library.ts ActionNeeded "projects"). Use <default>
 * makes it; Choose… opens the Mac app's folder window when this Mac is the computer doing the work, else Settings →
 * Folders. The waiting job is taken again once the row is there: nothing more to press.
 */
function ProjectsCard({ action }: { action: Extract<ActionNeeded, { kind: "projects" }> }) {
  const navigate = useNavigate();
  const [state, setState] = useState<"busy" | "set" | "failed" | null>(null);
  const use = async (path: string | null | undefined) => {
    if (!path) return;
    setState("busy");
    setState((await addProjectsFolder(action, path)) ? "set" : "failed");
  };
  const here = !!thisMacBridge() && thisMacDevice() === action.device;
  return (
    <div className="my-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
      <p className="w-full">{LIBRARY_WORDS.projectsCard(action.workspaceName)}</p>
      {state === "set" ? (
        <p className="text-xs text-muted-foreground">{LIBRARY_WORDS.projectsSet}</p>
      ) : (
        <>
          <Button size="sm" disabled={state === "busy"} onClick={() => void use(action.path)} title={action.path}>
            {LIBRARY_WORDS.projectsUse(action.path)}
          </Button>
          <Button size="sm" variant="outline" disabled={state === "busy"}
            onClick={() => (here ? void chooseFolderOnMac().then(use) : navigate("/settings/folders"))}>
            {LIBRARY_WORDS.projectsChoose}
          </Button>
        </>
      )}
      {state === "failed" && <p className="w-full text-xs text-destructive">{LIBRARY_WORDS.projectsFailed}</p>}
    </div>
  );
}
