import type { ReactNode } from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

/** Every drop zone: dashed border, lit violet while a file is dragged over it. Pass extra classes for size. */
// eslint-disable-next-line react-refresh/only-export-components -- the class goes on drop zones that aren't this component
export function dropZoneClass(drag: boolean, className?: string) {
  return cn(
    "flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-8 py-14 text-center transition-colors",
    drag
      ? "border-violet-500 bg-violet-500/10"
      : "border-zinc-700 bg-zinc-900/50 hover:border-zinc-500",
    className,
  );
}

/** The zone's content: cloud icon, one bold line, one quiet line. */
export function DropZoneText({ title, hint }: { title: ReactNode; hint: ReactNode }) {
  return (
    <>
      <UploadCloud className="mb-4 h-10 w-10 text-zinc-500" />
      <span className="block text-base font-semibold">{title}</span>
      <span className="mt-2 block text-sm text-zinc-500">{hint}</span>
    </>
  );
}
