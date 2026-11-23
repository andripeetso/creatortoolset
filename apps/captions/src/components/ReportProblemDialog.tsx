import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { msg } from "./settings/helpers";

const KINDS = [
  { id: "bug", label: "Something doesn't work" },
  { id: "feature", label: "Feature request" },
  { id: "other", label: "Other" },
] as const;

/**
 * Report a problem without the assistant (its AI may be the thing that fails): the person's words and the details the
 * server adds (api/bug-report.ts), shown under "What is sent" before Send.
 */
export function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const [kind, setKind] = useState<string>("bug");
  const [what, setWhat] = useState("");
  const [steps, setSteps] = useState("");
  const [details, setDetails] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/bug-report")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load the details"))))
      .then((d) => live && setDetails(JSON.stringify(d, null, 2)), (e) => live && setDetails(msg(e)));
    return () => {
      live = false;
    };
  }, []);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const r = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, what, steps, page: pathname, send: true }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; ref?: string };
      if (!r.ok) throw new Error(j.error ?? "Could not send the report");
      toast.success(`Report sent · ${j.ref}`);
      onClose();
    } catch (e) {
      setError(msg(e)); // what they typed stays
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-lg">
        <DialogTitle className="text-base font-semibold">Report a problem</DialogTitle>
        <DialogDescription>Goes to the Creator Toolset maintainers with the details below.</DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger size="sm" aria-label="Kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex flex-col gap-1 text-xs font-medium">
            What happened
            <Textarea value={what} onChange={(e) => setWhat(e.target.value)} maxLength={8000} rows={4} required />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Steps
            <Textarea value={steps} onChange={(e) => setSteps(e.target.value)} maxLength={4000} rows={3} />
          </label>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">What is sent</summary>
            <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">{details ?? "Loading"}</pre>
          </details>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={sending}>
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
