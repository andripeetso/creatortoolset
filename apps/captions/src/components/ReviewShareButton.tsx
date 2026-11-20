import { confirmDialog } from "@/lib/dialogs";
import { useState } from "react";
import { Check, Copy, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { ReviewShare, SharePatch } from "@/lib/review";
import { cn } from "@/lib/utils";

/** Review link popover, for one video or a whole project. */
export function ReviewShareButton({
  share,
  url,
  what,
  update,
  warning,
  className,
}: {
  share: ReviewShare | null | undefined;
  url: string;
  /** What the link opens: "every version", "every video in this project". */
  what: string;
  update: (patch: SharePatch) => Promise<void>;
  /** Shown on the link while it is on: what it shows that it should not. */
  warning?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const change = (patch: SharePatch) => void update(patch).then(() => setError(""), (e: Error) => setError(e.message));
  return (
    <Popover
      onOpenChange={(open) => {
        // first open turns the link on: that is what "Share" means
        if (open && !share) change({ enabled: true });
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" title={warning} className={cn("h-7 bg-violet-600 text-xs text-white hover:bg-violet-500", warning && "ring-2 ring-amber-400", className)}>
          <Share2 /> <span className="hidden sm:inline">Share</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-sm font-medium">Review link</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Anyone with the link can watch {what} and comment.
        </p>
        {warning && <p className="mt-2 text-xs text-amber-300">{warning}</p>}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        {share ? (
          <>
            <div className="mt-3 flex gap-1.5">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className={cn("min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs", !share.enabled && "opacity-40")}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={!share.enabled}
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <label className="mt-3 flex items-center justify-between text-sm">
              Link on
              <Switch checked={share.enabled} onCheckedChange={(v) => change({ enabled: v })} />
            </label>
            <label className="mt-2 flex items-center justify-between text-sm">
              Reviewers can download
              <Switch checked={share.download} onCheckedChange={(v) => change({ download: v })} />
            </label>
            <button
              className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                void confirmDialog({ title: "Reset the link?", body: "The current link stops working.", ok: "Reset" }).then((yes) => {
                  if (yes) change({ reset: true });
                });
              }}
            >
              Reset link
            </button>
          </>
        ) : error ? null : (
          <Loader2 className="mt-3 h-4 w-4 animate-spin" />
        )}
      </PopoverContent>
    </Popover>
  );
}
