import { lazy, Suspense } from "react";
import { BookOpen, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const CleanGuideContent = lazy(() => import("./CleanGuideContent"));

export function CleanGuideDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Open Video Cleaner guide"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Guide</span>
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-zinc-700 bg-zinc-950 p-0 text-zinc-200 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b border-zinc-800 px-5 py-5 pr-12 sm:px-7">
          <DialogTitle>Video Cleaner guide</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Editing, reference ranges, metadata cleanup and exports.
          </DialogDescription>
        </DialogHeader>
        <div
          role="document"
          tabIndex={0}
          aria-label="Video Cleaner README"
          className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-400 sm:px-7"
        >
          <Suspense
            fallback={
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-zinc-400"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading guide…
              </p>
            }
          >
            <CleanGuideContent />
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  );
}
