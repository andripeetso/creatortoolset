import { useEffect, useRef, useState, type ReactNode } from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { uploadFile } from "@/lib/library";
import { getSessionFinals, putFinal, type SessionStatus } from "@/lib/workshop";
import { cn } from "@/lib/utils";

type Ask = { id: string; title: string; libraryId: string; finalsId?: string };

/**
 * A project set to Ready to post or Published with no final video in Finals: the finished file is asked for, made
 * outside the app or not (owner, 2026-11-16). `ask(id, title, status)` after the status is saved; render `dialog`.
 */
export function useAskFinal(): [(id: string, title: string, status: SessionStatus | undefined) => void, ReactNode] {
  const [open, setOpen] = useState<Ask | null>(null);
  const ask = (id: string, title: string, status: SessionStatus | undefined) => {
    if (status !== "toPost" && status !== "published") return;
    getSessionFinals(id).then(
      (f) => !f.linked && f.libraryId && setOpen({ id, title, libraryId: f.libraryId, finalsId: f.finalsId ?? undefined }),
      () => {},
    );
  };
  return [ask, open && <AddFinalDialog key={open.id} ask={open} onClose={() => setOpen(null)} />];
}

/** On a project that is ready to post or published with no final video yet: the button that asks for it (a project set
 *  to Published before, or a "Not now"). Moved there while open, by the person or the chat, it asks at once. Nothing
 *  while it has one, or when there is no Media Library. */
export function AddFinalButton({ id, title, status }: { id: string; title: string; status: SessionStatus | undefined }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [open, setOpen] = useState(false);
  const due = status === "toPost" || status === "published";
  const was = useRef(status);
  useEffect(() => {
    const arrived = due && was.current !== "toPost" && was.current !== "published";
    was.current = status;
    if (!due || open) return;
    let live = true;
    getSessionFinals(id).then((f) => {
      if (!live) return;
      const next = !f.linked && f.libraryId ? { id, title, libraryId: f.libraryId, finalsId: f.finalsId ?? undefined } : null;
      setAsk(next);
      if (next && arrived) setOpen(true);
    }, () => {});
    return () => {
      live = false;
    };
  }, [id, title, status, due, open]);
  if (!due || !ask) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-7 shrink-0 rounded-md border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
      >
        Add final video
      </button>
      {open && <AddFinalDialog ask={ask} onClose={() => setOpen(false)} />}
    </>
  );
}

function AddFinalDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState(0);
  const [stage, setStage] = useState<"pick" | "upload" | "finals" | "done">("pick");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const stop = useRef<AbortController | null>(null);

  const send = async (f: File | undefined) => {
    if (!f || stage !== "pick") return;
    const ctl = new AbortController();
    stop.current = ctl;
    setFile(f);
    setError("");
    setSent(0);
    setStage("upload");
    try {
      const up = await uploadFile(ask.libraryId, f, (n) => setSent(n), ask.finalsId, undefined, { signal: ctl.signal });
      const id = up.assetId ?? up.duplicateOf;
      if (!id) throw new Error("The upload did not finish");
      setStage("finals");
      await putFinal(ask.id, id);
      setStage("done");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setStage("pick");
    }
  };
  const close = () => {
    stop.current?.abort();
    onClose();
  };

  const pct = file?.size ? Math.min(100, Math.round((sent / file.size) * 100)) : 0;
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-md"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void send(e.dataTransfer.files[0]);
        }}
      >
        <DialogTitle>Add the final video</DialogTitle>
        <DialogDescription className="text-zinc-500">
          {ask.title || "This project"} has no final video in Finals yet. The finished file goes there, linked to this project.
        </DialogDescription>
        {stage === "pick" ? (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center text-sm hover:border-violet-500/60",
              over ? "border-violet-500 bg-violet-950/30" : "border-zinc-800",
            )}
          >
            <UploadCloud className="h-6 w-6 text-zinc-500" />
            <span className="font-medium text-zinc-200">Drop the final video here</span>
            <span className="text-xs text-zinc-500">or click to pick it</span>
          </button>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-sm">
            <div className="truncate">{file?.name}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {stage === "upload" ? `Uploading ${pct}%` : stage === "finals" ? "Adding to Finals" : "In Finals"}
            </div>
            {stage === "upload" && (
              <div className="mt-2 h-1 overflow-hidden rounded bg-zinc-800">
                <div className="h-full bg-violet-500 transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end">
          <Button variant="outline" onClick={close} className="border-zinc-800 bg-transparent">
            {stage === "done" ? "Done" : stage === "pick" ? "Not now" : "Cancel"}
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept="video/*,.mov,.mxf,.mkv"
          hidden
          onChange={(e) => {
            void send(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
