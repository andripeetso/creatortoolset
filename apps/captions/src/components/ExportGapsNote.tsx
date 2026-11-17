import { exportEditor, type ExportEditor, type ExportGaps } from "@contracts/editor";

const NAMES: Record<ExportEditor, string> = { resolve: "Resolve", "final-cut": "Final Cut Pro", premiere: "Premiere Pro" };

/** "Won't match the preview in Resolve: shake on 54 shots, …" for that editor (a Mac editor id), or null when it carries it all. */
export function gapsLine(gaps: ExportGaps | undefined, editor: string): string | null {
  const e = exportEditor(editor);
  const left = e ? gaps?.[e] : undefined;
  return e && left?.length ? `Won't match the preview in ${NAMES[e]}: ${left.join(", ")}` : null;
}

/** A quiet line under a draft's Open in … per editor whose file leaves something out; nothing when none does. */
export function ExportGapsNote({ gaps, editors }: { gaps: ExportGaps | undefined; editors: string[] }) {
  const seen = new Set<ExportEditor | null>();
  const lines = editors.flatMap((id) => {
    const e = exportEditor(id);
    if (seen.has(e)) return [];
    seen.add(e);
    const line = gapsLine(gaps, id);
    return line ? [line] : [];
  });
  if (!lines.length) return null;
  return (
    <div className="grid gap-0.5 text-xs text-zinc-500">
      {lines.map((l) => <p key={l}>{l}</p>)}
    </div>
  );
}
