import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { MoreHorizontal, Plus } from "lucide-react";
import type { DesignSummary } from "@contracts/design";
import { AppBar } from "@/components/AppBar";
import { DesignThumb } from "@/components/design/DesignThumb";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createDesign, deleteDesign, listDesigns, saveDesign } from "@/lib/designs";
import { onTopic } from "@/lib/sync";

/**
 * The Designer's start (/design): every design of this account, newest first, each opening in the designer
 * (/design/:id), and New canvas for an empty canvas (its frames are made on it: the frame tool offers the picture
 * sizes). A carousel piece's design is started
 * from the piece (Design, beside Visualize in the Content Workshop), a cover from a video in Finals: both are listed
 * here too. A design made or changed somewhere else (the assistant, another window) shows without a reload.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const madeFrom = (d: DesignSummary) => (!d.from ? "" : "session" in d.from ? "From a Workshop carousel" : "From a video");

export default function DesignsPage() {
  const navigate = useNavigate();
  const [designs, setDesigns] = useState<DesignSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DesignSummary | null>(null);

  const load = useCallback(() => listDesigns().then((all) => (setDesigns(all), setError(null)), (e) => setError(message(e))), []);
  useEffect(() => {
    void load();
    // this window's own changes too: a rename or a delete here is shown from what the server kept
    return onTopic("designs", () => void load(), { own: true });
  }, [load]);

  const start = async () => {
    try {
      // an empty canvas: no frame yet (the size is only what a frame made by a click starts as)
      navigate(`/design/${(await createDesign({ format: "portrait", blank: true, pages: 0, name: "Untitled canvas" })).id}`);
    } catch (e) {
      setError(message(e));
    }
  };
  const rename = async (d: DesignSummary, name: string) => {
    setRenaming(null);
    if (!name || name === d.name) return;
    await saveDesign(d.id, { name }).then(load, (e) => setError(message(e)));
  };

  return (
    <div className="flex min-h-screen flex-col">
      <AppBar tool="Designer">
        <Button size="sm" onClick={() => void start()}>
          <Plus className="h-4 w-4" />
          New canvas
        </Button>
      </AppBar>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        {designs?.length === 0 && (
          <p className="py-16 text-center text-sm text-zinc-500">
            Nothing here yet. New canvas opens an empty canvas; Design on a carousel piece in the <Link to="/workshop" className="underline">Content Workshop</Link> starts from its slides.
          </p>
        )}
        <ul aria-label="Designs" className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {(designs ?? []).map((d) => (
            <li key={d.id} className="group relative flex flex-col gap-2">
              <Link to={`/design/${d.id}`} aria-label={`Open ${d.name}`} className="block overflow-hidden rounded-lg border border-zinc-500/20 outline-none transition hover:border-zinc-500/50 focus-visible:border-violet-500">
                <DesignThumb id={d.id} stamp={d.updatedAt} width={d.width} height={d.height} />
              </Link>
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  {renaming === d.id ? (
                    <input
                      autoFocus
                      aria-label="The design's name"
                      defaultValue={d.name}
                      maxLength={120}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : e.key === "Escape" ? setRenaming(null) : undefined)}
                      onBlur={(e) => void rename(d, e.currentTarget.value.trim())}
                      className="w-full rounded-sm bg-transparent text-sm font-medium outline outline-1 outline-violet-500"
                    />
                  ) : (
                    <p className="truncate text-sm font-medium">{d.name}</p>
                  )}
                  <p className="truncate text-xs text-zinc-500">
                    {d.pages ? `${d.pages} ${d.pages === 1 ? "frame" : "frames"}` : "No frames yet"}
                    {madeFrom(d) && ` · ${madeFrom(d)}`}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger aria-label={`More for ${d.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-500/15">
                    <MoreHorizontal className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(d.id)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDeleting(d)}>Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Its frames and the pictures added to it are deleted for good. PNGs you saved stay where you saved them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && void deleteDesign(deleting.id).then(load, (e) => setError(message(e)))}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
