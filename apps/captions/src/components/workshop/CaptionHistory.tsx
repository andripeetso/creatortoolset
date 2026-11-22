import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { timeAgo } from "@/lib/exports";
import type { CaptionTake } from "@/lib/workshop";

/** The post description's own history: each earlier take from the piece's versions, and Restore to bring one back. */
export function CaptionHistory({
  disabled,
  load,
  onUse,
}: {
  disabled: boolean;
  load: () => Promise<CaptionTake[]>;
  onUse: (versionId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [takes, setTakes] = useState<CaptionTake[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [using, setUsing] = useState<string | null>(null);
  // an answer for an earlier opening is dropped
  const asked = useRef(0);
  const fetchTakes = () => {
    const n = ++asked.current;
    setFailed(false);
    setTakes(null);
    load().then(
      (t) => n === asked.current && setTakes(t),
      () => n === asked.current && setFailed(true),
    );
  };
  const use = async (versionId: string) => {
    setUsing(versionId);
    try {
      await onUse(versionId);
      setOpen(false);
    } finally {
      setUsing(null);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) fetchTakes();
        else asked.current++;
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="Earlier post descriptions"
          className="invisible text-[11px] text-muted-foreground hover:text-foreground group-hover:visible group-focus-within:visible disabled:opacity-40 data-[state=open]:visible data-[state=open]:text-foreground"
        >
          History
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-96 w-96 flex-col gap-1 overflow-y-auto p-1">
        {failed ? (
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            Could not load post descriptions
            <button type="button" onClick={fetchTakes} className="rounded-md px-2 py-0.5 hover:bg-muted hover:text-foreground">
              Retry
            </button>
          </div>
        ) : !takes ? (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        ) : !takes.length ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No earlier post descriptions</p>
        ) : (
          takes.map((t) => (
            <div key={t.versionId} className="rounded-md px-2 py-1.5 hover:bg-muted/60">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className={`h-1.5 w-1.5 rounded-full ${t.author === "user" ? "bg-amber-400/70" : "bg-violet-400/50"}`} />
                <span>
                  {t.author === "user" ? "Yours" : "Written"} · {timeAgo(t.at)}
                </span>
                <button
                  type="button"
                  disabled={!!using}
                  onClick={() => void use(t.versionId)}
                  className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {using === t.versionId ? "Restoring" : "Restore"}
                </button>
              </div>
              <p className="line-clamp-6 whitespace-pre-line text-[12px] leading-relaxed text-foreground/90">{t.text}</p>
            </div>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
