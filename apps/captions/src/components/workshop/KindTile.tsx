import type { DocKind } from "@/lib/workshop";

type PieceKind = Exclude<DocKind, "notes">;

const TILE: Record<PieceKind, { letter: string; cls: string; label: string }> = {
  reel: { letter: "R", cls: "bg-rose-500/20 text-rose-300", label: "Reel" },
  carousel: { letter: "C", cls: "bg-sky-500/20 text-sky-300", label: "Carousel" },
  ad: { letter: "A", cls: "bg-emerald-500/20 text-emerald-300", label: "Ad copy" },
  free: { letter: "F", cls: "bg-zinc-500/25 text-zinc-300", label: "Anything else" },
  youtube: { letter: "Y", cls: "bg-red-500/20 text-red-300", label: "YouTube script" },
  newsletter: { letter: "N", cls: "bg-amber-500/20 text-amber-300", label: "Newsletter" },
  thread: { letter: "X", cls: "bg-zinc-200/15 text-zinc-200", label: "X post / thread" },
  article: { letter: "B", cls: "bg-indigo-500/20 text-indigo-300", label: "Article / blog" },
};

/** What a session makes, as one same-width letter tile in front of its name. */
export function KindTile({ kind, className = "" }: { kind?: PieceKind; className?: string }) {
  const t = kind ? TILE[kind] : null;
  return (
    <span
      title={t?.label ?? "Nothing written yet"}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold ${t ? t.cls : "border border-dashed border-zinc-600 text-transparent"} ${className}`}
    >
      {t?.letter ?? "·"}
    </span>
  );
}
