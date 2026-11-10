import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ProjectList } from "@/components/workspace/ProjectList";

/**
 * Projects, a window over the page you were on, like Settings: Esc, the ✕ or a click outside goes back.
 */
export default function ProjectsPage({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(900px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="border-b border-border px-6 py-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">Projects</DialogTitle>
          <p className="text-sm text-muted-foreground">The current project is what the Analyzer and the Content Workshop work in.</p>
        </div>
        <div className="min-h-0 flex-auto overflow-y-auto px-6 py-4">
          <ProjectList />
        </div>
      </DialogContent>
    </Dialog>
  );
}
