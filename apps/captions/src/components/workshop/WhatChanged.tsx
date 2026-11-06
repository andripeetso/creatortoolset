import { useEffect, useState } from "react";
import { getVersion, type ChatMessage, type WorkshopDocument } from "@/lib/workshop";
import { wordDiff, type DiffPiece } from "./word-diff";

type Edits = NonNullable<ChatMessage["edits"]>;
type Row = { id: string; label: string; note?: string; parts: DiffPiece[] };

/** The changed blocks as they stand now: slides or parts, hooks, the post description and the pinned comment. */
function liveTexts(doc: WorkshopDocument, ids: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of ids) {
    const text =
      id === "caption" ? doc.caption?.text : id === "pinned" ? doc.pinned?.text : /^h\d/.test(id) ? doc.hooks?.find((h) => h.id === id)?.text : doc.blocks.find((b) => b.id === id)?.text;
    if (text !== undefined) m.set(id, text);
  }
  return m;
}

function labelOf(doc: WorkshopDocument, id: string): string {
  if (id === "caption") return "Post description";
  if (id === "pinned") return "Pinned comment";
  if (/^h\d/.test(id)) return `Hook ${id.slice(1)}`;
  const at = doc.blocks.findIndex((b) => b.id === id);
  const unit = doc.kind === "carousel" ? "Slide" : "Part";
  return at >= 0 ? `${unit} ${at + 1}` : unit;
}

/** "What changed" for one turn: each block the turn wrote, before against now, word by word. */
export function WhatChanged({ sessionId, doc, edits }: { sessionId: string; doc: WorkshopDocument; edits: Edits }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blockKey = edits.blockIds.join(",");

  useEffect(() => {
    let stale = false;
    const ids = [...new Set(blockKey.split(",").filter(Boolean))];
    const fromVersion = (versionId: string) =>
      getVersion(sessionId, doc.id, versionId, ids).then((v) => new Map(v.blocks.map((b) => [b.id, b.text] as const)));
    const before = edits.versionBefore ? fromVersion(edits.versionBefore) : Promise.resolve(new Map<string, string>());
    const after = edits.versionAfter ? fromVersion(edits.versionAfter) : Promise.resolve(liveTexts(doc, ids));
    Promise.all([before, after])
      .then(([was, now]) => {
        if (stale) return;
        setRows(
          ids.flatMap((id) => {
            const a = was.get(id);
            const b = now.get(id);
            if (a === undefined && b === undefined) return [];
            const parts = wordDiff(a ?? "", b ?? "");
            if (!parts.some((p) => p.kind !== "same")) return [];
            return [{ id, label: labelOf(doc, id), note: a === undefined ? "new" : b === undefined ? "deleted" : undefined, parts }];
          }),
        );
      })
      .catch((e: Error & { status?: number }) => {
        if (!stale) setError(e.status === 404 ? "The text from before this turn was pruned, so there is nothing to compare with." : e.message);
      });
    return () => {
      stale = true;
    };
  }, [sessionId, doc, edits.versionBefore, edits.versionAfter, blockKey]);

  return (
    <div className="mt-1.5 flex flex-col gap-3 rounded-lg border border-border bg-background/70 p-2.5 text-[13px] leading-relaxed text-foreground">
      <p className="text-[10px] text-muted-foreground">
        Before this turn against {edits.versionAfter ? "the text as the turn left it" : "the text now"} ·{" "}
        <del className="rounded-sm bg-red-500/20 px-0.5 text-red-200/90 line-through">removed</del>{" "}
        <ins className="rounded-sm bg-emerald-500/20 px-0.5 text-emerald-100 no-underline">added</ins>
      </p>
      {error ? <p className="text-[12px] text-red-300">{error}</p> : null}
      {!error && rows === null ? <p className="text-[12px] text-muted-foreground">Loading…</p> : null}
      {rows?.length === 0 ? <p className="text-[12px] text-muted-foreground">The words of these blocks are the same as before.</p> : null}
      {rows?.map((r) => (
        <div key={r.id}>
          <p className="text-[11px] text-muted-foreground">
            {r.label}
            {r.note ? <span className="ml-1.5 rounded bg-muted px-1 text-[10px]">{r.note}</span> : null}
          </p>
          <p className="whitespace-pre-wrap">
            {r.parts.map((p, i) =>
              p.kind === "same" ? (
                <span key={i}>{p.text}</span>
              ) : p.kind === "add" ? (
                <ins key={i} className="rounded-sm bg-emerald-500/20 text-emerald-100 no-underline">
                  {p.text}
                </ins>
              ) : (
                <del key={i} className="rounded-sm bg-red-500/20 text-red-200/90 line-through">
                  {p.text}
                </del>
              ),
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
