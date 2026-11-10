import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { WorkshopShareView } from "@/pages/WorkshopSharePage";
import { Check, CheckCircle2, Copy, Download, ExternalLink, Hammer, Link2, Loader2, X } from "lucide-react";
import { listShares, shareDeliveryUrl, shareSession, stopShare, workshopShareUrl, type SessionStatus, type WorkshopShareLink } from "@/lib/workshop";

/**
 * Share the whole project: one link per session with every piece in it, new ones too.
 * The freelancer opens it without an account, marks "producing" / "done" and
 * uploads the finals; both show here with downloads.
 */
/** onStatus: the session's status after sharing (an idea, writing or ready session moves to In Production). */
export function SharePopover({
  sessionId,
  title,
  className,
  align = "right",
  onStatus,
  shared,
  onShared,
}: {
  sessionId: string;
  title?: string;
  className: string;
  align?: "right" | "left";
  onStatus?: (status: SessionStatus) => void;
  /** Whether a link is on, when the caller knows (the sessions list); else it's asked once. */
  shared?: boolean;
  onShared?: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  /** The share page in a window over the session (Esc, ✕ or a click outside closes it). */
  const [viewing, setViewing] = useState<string | null>(null);
  // the button says whether a link is on: green "Shared" with a dot, or "Share"
  const [on, setOn] = useState(shared ?? false);
  useEffect(() => {
    if (shared !== undefined) return setOn(shared);
    listShares(sessionId).then((all) => setOn(all.some((s) => s.all)), () => {});
  }, [sessionId, shared]);
  const turn = (v: boolean) => {
    setOn(v);
    onShared?.(v);
  };
  const [link, setLink] = useState<WorkshopShareLink | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoaded(false);
    listShares(sessionId).then(
      (all) => {
        setLink(all.find((s) => s.all) ?? null);
        setOn(all.some((s) => s.all));
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [open, sessionId]);

  const copy = (token: string) => {
    void navigator.clipboard.writeText(workshopShareUrl(token)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const l = await shareSession(sessionId);
      if (l.status) onStatus?.(l.status);
      setLink(l);
      turn(true);
      copy(l.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!link) return;
    try {
      await stopShare(sessionId, link.token);
      setLink(null);
      turn(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <span className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${className} ${on ? "!border-emerald-500/50 !text-emerald-300" : ""}`}
        aria-expanded={open}
        title={on ? "A share link is on: anyone with it can read every piece. Click to copy or stop it." : "Share this project with freelancers and team: one link, every piece, no account"}
      >
        {on ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> : <Link2 className="h-3 w-3" />} {on ? "Shared" : "Share"}
      </button>
      {open ? (
        <div className={`absolute top-full z-50 mt-1 flex w-80 flex-col gap-2 rounded-lg border border-border bg-popover p-2.5 text-left text-popover-foreground shadow-xl ${align === "right" ? "right-0" : "left-0"}`}>
          <div className="flex items-center">
            <p className="min-w-0 truncate text-[12px] font-medium">Share {title ? `“${title}”` : "this project"}</p>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label="Close">
              <X className="h-3 w-3" />
            </button>
          </div>
          {!loaded ? (
            <span aria-hidden className="block h-[26px] rounded bg-muted/50" />
          ) : link ? (
            <>
              <div className="flex items-center gap-1.5">
                <input readOnly value={workshopShareUrl(link.token)} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-[11px] text-muted-foreground" />
                <button type="button" onClick={() => copy(link.token)} className="flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
                </button>
                {/* over this session (the Mac app has no address bar or back): the page as they see it, plus the comments panels for you */}
                <button type="button" onClick={() => (setViewing(link.token), setOpen(false))} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" title="Open the share page here">
                  <ExternalLink className="h-3 w-3" /> Open
                </button>
              </div>
              <p className="flex items-center gap-1.5 text-[11px]">
                {link.progress?.state === "done" ? (
                  <>
                    <CheckCircle2 className="h-3 w-3 text-emerald-400" /> Done{link.progress.by ? ` · ${link.progress.by}` : ""}
                  </>
                ) : link.progress?.state === "producing" ? (
                  <>
                    <Hammer className="h-3 w-3 text-amber-400" /> In production{link.progress.by ? ` · ${link.progress.by}` : ""}
                  </>
                ) : (
                  <span className="text-muted-foreground">Nobody has started on it yet.</span>
                )}
              </p>
              {link.deliveries?.length ? (
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border pt-1.5">
                  {link.deliveries.map((d) => (
                    <li key={d.id} className="flex items-center gap-1.5 text-[11px]">
                      <span className="min-w-0 flex-1 truncate" title={d.note ? `${d.name}: ${d.note}` : d.name}>
                        {d.name}
                        {d.by ? <span className="text-muted-foreground"> · {d.by}</span> : null}
                      </span>
                      <a href={shareDeliveryUrl(link.token, d.id, true)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Download">
                        <Download className="h-3 w-3" />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              <button type="button" onClick={() => void stop()} className="self-start rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-red-400">
                Stop this link
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void make()} className="flex items-center justify-center gap-1.5 rounded-md bg-violet-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />} Make a link and copy it
              </button>
              <p className="text-[10px] text-muted-foreground">Every piece in this project, live: what you add or change later shows up too. They open it without an account, mark their progress and upload the finals here.</p>
            </>
          )}
          {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
        </div>
      ) : null}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="block h-[92vh] max-w-[min(1400px,96vw)] overflow-y-auto border-zinc-800 bg-zinc-950 p-0 sm:max-w-[min(1400px,96vw)] [&>[data-slot=dialog-close]]:text-zinc-300">
          <DialogTitle className="sr-only">Share page</DialogTitle>
          {viewing ? <WorkshopShareView token={viewing} embedded /> : null}
        </DialogContent>
      </Dialog>
    </span>
  );
}
