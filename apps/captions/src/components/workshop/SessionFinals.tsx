import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { listShares, type WorkshopShareLink } from "@/lib/workshop";
import { FinalsGallery, SaveAllButton } from "./FinalsGallery";

/** What the freelancer delivered on this session's link, above the piece. */
export function SessionFinals({ sessionId }: { sessionId: string }) {
  const [link, setLink] = useState<WorkshopShareLink | null>(null);
  const [open, setOpen] = useState(() => localStorage.getItem(`ws.finals.${sessionId}`) !== "closed");
  useEffect(() => {
    const load = () =>
      listShares(sessionId)
        .then((all) => setLink(all.find((s) => s.deliveries?.length) ?? null))
        .catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [sessionId]);
  if (!link?.deliveries?.length) return null;
  const files = link.deliveries;
  const toggle = () => {
    localStorage.setItem(`ws.finals.${sessionId}`, open ? "closed" : "open");
    setOpen(!open);
  };
  return (
    <div className="shrink-0 border-b border-border px-5 py-2">
      <div className="flex items-center gap-2 text-[12px]">
        <button type="button" onClick={toggle} className="flex items-center gap-1 font-medium text-emerald-300 hover:text-emerald-200">
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} /> Finals · {files.length} {files.length === 1 ? "file" : "files"}
        </button>
        <span className="text-muted-foreground">
          {link.progress?.by ? `from ${link.progress.by}` : ""}
          {link.progress?.state === "done" ? " · done" : link.progress?.state === "producing" ? " · in production" : ""}
        </span>
        {open ? <SaveAllButton token={link.token} files={files} className="ml-auto !px-2.5 !py-1 !text-[12px]" /> : null}
      </div>
      {open ? (
        <div className="mt-2 max-h-[45vh] overflow-y-auto">
          <FinalsGallery token={link.token} files={files} className="grid-cols-4 lg:grid-cols-7" />
        </div>
      ) : null}
    </div>
  );
}
