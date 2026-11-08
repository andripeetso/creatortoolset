import { lazy, Suspense, useState } from "react";
import { Loader2, Scissors } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { EditOptions, EditMeasurement } from "@contracts/clean-edit";
const CleanClipEditor = lazy(() => import("./CleanClipEditor"));
export function CleanClipEditorDialog(props: {
  url: string;
  name: string;
  sourceId?: string;
  file?: File;
  options: EditOptions;
  duration: number;
  measurement?: EditMeasurement;
  disabled?: boolean;
  onApply: (options: EditOptions, measurement?: EditMeasurement) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const change = (value: boolean) => {
    setOpen(value);
    props.onOpenChange(value);
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={props.disabled || props.duration < 0.1}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          <Scissors className="h-3.5 w-3.5" />
          Edit clip
        </button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        className="flex h-[94dvh] max-w-[98vw] flex-col gap-0 overflow-hidden border-zinc-700 bg-zinc-950 p-0 text-zinc-200 sm:max-w-[1600px]"
      >
        <DialogTitle className="sr-only">Edit clip: {props.name}</DialogTitle>
        <DialogDescription className="sr-only">
          A separate editing workspace. Apply changes to return to Cleaner, or
          cancel to discard this draft. Escape cancels.
        </DialogDescription>
        {open && (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Opening editor…
              </div>
            }
          >
            <CleanClipEditor
              {...props}
              onCancel={() => change(false)}
              onApply={(options, measurement) => {
                props.onApply(options, measurement);
                change(false);
              }}
            />
          </Suspense>
        )}
      </DialogContent>
    </Dialog>
  );
}
