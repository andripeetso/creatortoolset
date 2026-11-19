import { useNavigate } from "react-router";
import type { WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { getWatch } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";

/**
 * The empty Media Library's first screen (UNIFIED-PRD §3.3): the owner gets Set up, which opens the setup sheet on
 * /library?setup=1, and Upload files; a member gets Upload files only. Upload files is the library's own picker (or
 * `onUpload`). No folder picker and no Copies card here: setup owns the folders. Also shown by the AI Editor's page.
 */
export function FootageFolderCard({ libraryId, onUpload, page = false, needsSetup = true }: { libraryId: string; onUpload?: () => void; page?: boolean; needsSetup?: boolean }) {
  const navigate = useNavigate();
  // only the owner gets the watch status: its presence is what makes this person the owner
  const live = useCachedLoad<WatchStatus>(`/api/library/${libraryId}/watch`, () => getWatch(libraryId));
  if (!live.data && !live.error) return null; // still being read
  const owner = !!live.data;

  const box = page
    ? "mx-auto flex w-full max-w-md flex-col items-center gap-5 py-10 text-center sm:py-14"
    : "flex flex-col items-center gap-3 rounded-xl border border-zinc-500/20 p-4 text-center";
  const size = page ? "default" : "sm";

  return (
    <section aria-label="Empty library" className={box}>
      {page && <p className="text-sm text-zinc-500">No clips</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {owner && needsSetup && (
          <Button size={size} onClick={() => navigate("/library?setup=1")}>
            Set up
          </Button>
        )}
        <Button size={size} variant={owner && needsSetup ? "outline" : "default"} onClick={() => (onUpload ? onUpload() : navigate("/library"))}>
          Upload files
        </Button>
      </div>
    </section>
  );
}
