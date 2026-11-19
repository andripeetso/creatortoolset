import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronLeft } from "lucide-react";
import { LIBRARY_WORDS, RETRY, type ActionNeeded, type CardAction } from "@contracts/library";
import type { FolderBrowse } from "@contracts/devices";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { thisMacDevice } from "@/lib/providers";
import { chooseFolderOnMac, thisMacBridge } from "@/lib/thisMac";

/** A card's request as the signed-in session; the answer's `error` when it was refused, else null. */
async function send(call: NonNullable<CardAction["call"]>): Promise<string | null> {
  const r = await fetch(call.path, {
    method: call.method,
    headers: { ...(call.body ? { "content-type": "application/json" } : {}), ...(call.workspace ? { "X-CT-Workspace": call.workspace } : {}) },
    ...(call.body ? { body: JSON.stringify(call.body) } : {}),
  }).catch(() => null);
  if (r?.ok) return null;
  const said = ((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "";
  // already there (a second tap, another window): what the card asked for
  return /already/i.test(said) ? null : said || "That didn't work";
}

/** A folder picked in a `browse` action: the row Settings → Folders adds, on that computer, in that workspace. */
const pickCall = (b: NonNullable<CardAction["browse"]>, path: string): NonNullable<CardAction["call"]> => ({
  method: "POST",
  path: "/api/devices/storage/folders",
  body: { role: b.role, host: b.device, path, make: true },
  workspace: b.workspace,
});

/**
 * The card under a reply whose tool needs the person first (ActionNeeded, contracts/library.ts): drawn from its title,
 * line and actions alone, the same card the phone draws. A press sends the action's request; the server then changes
 * the message (the next card, or none) and the chat goes on by itself. Choose… opens the Mac app's folder window when
 * this Mac is the computer, else the folder browser of that computer.
 */
export function ActionCard({ action }: { action?: ActionNeeded }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ error: string; call: NonNullable<CardAction["call"]> } | null>(null);
  const [browsing, setBrowsing] = useState<NonNullable<CardAction["browse"]> | null>(null);
  if (!action) return null;

  const run = async (call: NonNullable<CardAction["call"]>) => {
    setBusy(true);
    setFailed(null);
    const error = await send(call);
    setBusy(false);
    if (error) setFailed({ error, call });
  };
  const press = (a: CardAction) => {
    if (a.call) return void run(a.call);
    if (a.open) return navigate(a.open);
    const b = a.browse;
    if (!b) return;
    if (thisMacBridge() && thisMacDevice() === b.device) return void chooseFolderOnMac().then((p) => void (p && run(pickCall(b, p))));
    setBrowsing(b);
  };

  return (
    <div className="my-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
      <p className="w-full font-medium">{action.title}</p>
      <p className="w-full text-muted-foreground">{action.line}</p>
      {action.actions.map((a) => (
        // a long label (a folder's path) is cut with an ellipsis inside the card, never past its edge (the full label is the tooltip)
        <Button key={a.id} size="sm" className="min-w-0 max-w-full" variant={a.primary ? "default" : "outline"} disabled={busy} onClick={() => press(a)} title={a.label}>
          <span className="truncate">{a.label}</span>
        </Button>
      ))}
      {failed && (
        <p className="flex w-full items-center gap-2 text-xs text-destructive">
          {failed.error}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(failed.call)}>
            {RETRY}
          </Button>
        </p>
      )}
      {browsing && (
        <FolderBrowser
          at={browsing}
          onClose={() => setBrowsing(null)}
          onPick={(path) => {
            setBrowsing(null);
            void run(pickCall(browsing, path));
          }}
        />
      )}
    </div>
  );
}

/** One level of folders on a computer that is not this one (GET /api/devices/:id/browse): its roots, up, into, Use this folder. */
function FolderBrowser({ at, onClose, onPick }: { at: NonNullable<CardAction["browse"]>; onClose: () => void; onPick: (path: string) => void }) {
  const [shown, setShown] = useState<FolderBrowse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const open = async (path: string) => {
    setAsked(path);
    setError(null);
    const r = await fetch(`/api/devices/${encodeURIComponent(at.device)}/browse?path=${encodeURIComponent(path)}`).catch(() => null);
    const b = (await r?.json().catch(() => null)) as (FolderBrowse & { error?: string }) | null;
    if (r?.ok && b) setShown(b);
    else setError(b?.error ?? "That computer did not answer");
  };
  // the computer's home first (or the card's own start); shortcut: a slow answer that lands after a later click still shows
  useEffect(() => void open(at.start || "~"), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>{LIBRARY_WORDS.projectsChoose.replace("…", "")}</DialogTitle>
        <DialogDescription className="truncate" title={shown?.path}>
          {shown ? `${shown.deviceName}: ${shown.path}` : "…"}
        </DialogDescription>
        {shown && (
          <div className="flex flex-wrap gap-1">
            {shown.roots.map((r) => (
              <Button key={r.path} size="sm" variant="outline" onClick={() => void open(r.path)}>
                {r.name}
              </Button>
            ))}
          </div>
        )}
        <div className="max-h-72 overflow-y-auto rounded-md border border-border">
          {shown?.parent && (
            <button type="button" className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-sm hover:bg-muted/50" onClick={() => void open(shown.parent!)}>
              <ChevronLeft className="size-4" />
              Up
            </button>
          )}
          {shown?.dirs.map((d) => (
            <button key={d.path} type="button" className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted/50" onClick={() => void open(d.path)}>
              {d.name}
            </button>
          ))}
        </div>
        {error && (
          <p className="flex items-center gap-2 text-xs text-destructive">
            {error}
            <Button size="sm" variant="outline" onClick={() => void open(asked ?? "~")}>
              {RETRY}
            </Button>
          </p>
        )}
        <Button disabled={!shown} onClick={() => shown && onPick(shown.path)}>
          Use this folder
        </Button>
      </DialogContent>
    </Dialog>
  );
}
