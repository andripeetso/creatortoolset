import { useState, type ReactNode } from "react";
import { Bookmark, Check, ChevronDown, History, Plus, X } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { DOC_KINDS, countUnits, docKindLabel, docTabLabel, type DocKind, type WorkshopDocument } from "@/lib/workshop";

export const KIND_DOT: Record<DocKind, string> = {
  reel: "bg-rose-400",
  carousel: "bg-sky-400",
  ad: "bg-emerald-400",
  free: "bg-zinc-400",
  youtube: "bg-red-500",
  notes: "bg-amber-400",
};

/** The session's documents as tabs, with new / history. */
export function DocumentTabs({
  docs,
  activeId,
  busy,
  undo,
  onSelect,
  onCreate,
  onKind,
  onRevert,
  onKeep,
  onDelete,
  tools,
}: {
  docs: WorkshopDocument[];
  activeId: string | null;
  busy: boolean;
  undo?: { label: string; onUndo: () => void };
  onSelect: (id: string) => void;
  onCreate: (kind: Exclude<DocKind, "notes">) => void;
  onKind?: (kind: Exclude<DocKind, "notes">) => void;
  onRevert: (docId: string, versionId: string) => void;
  onKeep: (docId: string, input: { name?: string; versionId?: string; kept?: boolean }) => void;
  onDelete: (docId: string) => void;
  tools?: ReactNode;
}) {
  const [menu, setMenu] = useState<"new" | "history" | "kind" | null>(null);
  const [keepName, setKeepName] = useState("");
  const active = docs.find((d) => d.id === activeId) ?? null;
  const btn = "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
  return (
    // a narrow panel puts the tools on a second row instead of under the tabs
    <div className="flex h-full w-full min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-2 py-1">
      <div className="relative flex min-w-0 items-center gap-1">
        {/* many documents: the strip scrolls sideways, never under the toolbar */}
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {docs.map((d) => {
            const on = d.id === activeId;
            return (
              <div
                key={d.id}
                className={`group relative flex shrink-0 items-center rounded-md border ${
                  on ? "border-violet-500/50 bg-violet-600/25 text-violet-950 dark:text-violet-50" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (on) {
                      if (d.kind !== "notes") setMenu((m) => (m === "kind" ? null : "kind"));
                      return;
                    }
                    setMenu(null);
                    onSelect(d.id);
                  }}
                  className="flex items-center gap-1.5 px-2 py-1 text-[11px]"
                  aria-expanded={on && menu === "kind"}
                  title={d.kind === "notes" ? "Notes" : on ? "Change type — reel, carousel, ad, or free-form" : `${docKindLabel(d.kind)} · ${countUnits(d.kind, d.blocks.length)}`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[d.kind]}`} />
                  <span className="max-w-[10rem] truncate">{docTabLabel(d)}</span>
                  {on && d.kind !== "notes" ? <ChevronDown className={`h-3 w-3 shrink-0 ${menu === "kind" ? "rotate-180" : ""}`} /> : null}
                </button>
                {d.kind !== "notes" && (
                  <ConfirmButton
                    label={<X className="h-3 w-3" />}
                    confirmLabel="Delete?"
                    disabled={busy}
                    onConfirm={() => onDelete(d.id)}
                    title="Delete this document"
                    className={`mr-1 rounded px-0.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 ${on ? "" : "hidden group-hover:inline"}`}
                    armedClassName="!bg-red-500/15 !text-red-700 dark:!text-red-200"
                  />
                )}
              </div>
            );
          })}
        </div>
        {active && menu === "kind" && active.kind !== "notes" && onKind ? (
          <span className="absolute left-0 top-full z-40 mt-1 flex w-40 flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
            {DOC_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  setMenu(null);
                  if (k.id !== active.kind) onKind(k.id);
                }}
                className={`rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-muted disabled:opacity-50 ${k.id === active.kind ? "text-foreground" : "text-muted-foreground"}`}
              >
                {k.label}
              </button>
            ))}
          </span>
        ) : null}
        <span className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenu((m) => (m === "new" ? null : "new"))}
            disabled={busy}
            className={btn}
            aria-expanded={menu === "new"}
            title="Another document — pick reel, carousel, ad, or free-form"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
          {menu === "new" && (
            <span className="absolute left-0 top-full z-30 mt-1 flex w-40 flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
              {DOC_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMenu(null);
                    onCreate(k.id);
                  }}
                  className="rounded-md px-2 py-1.5 text-left text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {k.label}
                </button>
              ))}
            </span>
          )}
        </span>
        {undo ? (
          <button type="button" onClick={undo.onUndo} disabled={busy} className={`${btn} shrink-0`} title={`Bring back “${undo.label}”`}>
            Undo
          </button>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {active && active.kind !== "notes" && (
          <span className="relative shrink-0">
            <button type="button" onClick={() => setMenu((m) => (m === "history" ? null : "history"))} className={btn} title="Versions — keep one with a name to come back to it">
              <History className="h-3.5 w-3.5" />
              {versionTrigger(active)}
              <ChevronDown className="h-3 w-3" />
            </button>
            {menu === "history" && (
              <span className="absolute right-0 top-full z-30 mt-1 flex max-h-80 w-80 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <form
                  className="flex gap-1 border-b border-border px-1 pb-1.5 pt-0.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onKeep(active.id, { name: keepName.trim() || undefined });
                    setKeepName("");
                  }}
                >
                  <input
                    value={keepName}
                    onChange={(e) => setKeepName(e.target.value)}
                    disabled={busy}
                    placeholder="this was good"
                    aria-label="Name for this version"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
                  />
                  <button type="submit" disabled={busy} className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                    Keep
                  </button>
                </form>
                <span className="px-2 py-1 text-[10px] text-muted-foreground">{active.versions.length ? "Restore a version, or bookmark one to keep it" : "None yet — Keep saves the current text as a named snapshot."}</span>
                {[...active.versions].reverse().map((v) => {
                  const current = v.id === active.headVersion;
                  return (
                    <span key={v.id} className={`flex items-stretch gap-0.5 rounded ${current ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"}`}>
                      <button
                        type="button"
                        disabled={busy || current}
                        onClick={() => {
                          setMenu(null);
                          onRevert(active.id, v.id);
                        }}
                        className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1 text-left text-[11px] hover:text-foreground disabled:opacity-100"
                        title={current ? "This is the current text" : "Restore this version"}
                      >
                        <span className="shrink-0 font-mono text-muted-foreground">{v.id}</span>
                        <span className="min-w-0 flex-1 truncate">{v.label}</span>
                        {current ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" /> : null}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onKeep(active.id, { versionId: v.id, kept: !v.kept })}
                        title={v.kept ? "Stop keeping this version" : "Keep this version"}
                        className={`shrink-0 rounded px-1.5 py-1 ${v.kept ? "text-amber-500 hover:text-amber-400" : "text-muted-foreground/50 hover:text-foreground"}`}
                      >
                        <Bookmark className={`h-3 w-3 ${v.kept ? "fill-current" : ""}`} />
                      </button>
                    </span>
                  );
                })}
                {active.versions.length > 0 && !active.headVersion ? <span className="px-2 py-1 text-[10px] text-muted-foreground">The text has been edited since the latest version — Keep saves it.</span> : null}
              </span>
            )}
          </span>
        )}
        {tools}
      </div>
    </div>
  );
}

function versionTrigger(doc: WorkshopDocument): string {
  if (!doc.versions.length) return "no versions";
  const last = doc.versions[doc.versions.length - 1]!;
  const head = doc.headVersion ? doc.versions.find((v) => v.id === doc.headVersion) : undefined;
  if (head?.kept) return `${head.id} · ${head.label}`;
  if (doc.headVersion) return doc.headVersion;
  return `${last.id} · edited`;
}
