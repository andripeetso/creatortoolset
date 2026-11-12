import { useState } from "react";
import { EMPTIED, type KeptKind, type KeptRow, type KeptView } from "@contracts/storage";
import { Button } from "@/components/ui/button";
import { useCachedLoad } from "@/lib/local-cache";
import { call } from "./StorageRows";
import { Card, EmptyRow, ErrorRow, LoadingRow, Row, Section } from "./ui";

/**
 * "Kept on the server" (api/kept.ts): what this account keeps in the server's data folder, one row per kind with its size,
 * the biggest first, and the total beside the title. Each row has a bar: its share of everything kept, all on one scale
 * and in one colour, so the rows compare at a glance (the same bar as Settings → Usage). The trash, a chat's pictures and
 * videos and finished renders have Empty (a second press confirms); the rest is the account's work, deleted one by one in
 * its own tool.
 */

const KEPT_API = "/api/devices/storage/kept";

const LABEL: Record<KeptKind, [title: string, one: string, many: string]> = {
  captions: ["Caption Studio projects", "project", "projects"],
  review: ["Review videos", "video", "videos"],
  notes: ["Video Notes", "note", "notes"],
  guides: ["Guides", "guide", "guides"],
  enhance: ["Audio Enhancer sessions", "session", "sessions"],
  editor: ["AI Editor edits", "edit", "edits"],
  analyzer: ["Analyzer posts", "post", "posts"],
  workshop: ["Workshop sessions and sources", "item", "items"],
  "captions-trash": ["Deleted Caption Studio projects", "project", "projects"],
  "review-trash": ["Deleted Review videos", "video", "videos"],
  library: ["Media Library", "item", "items"],
  "chat-pictures": ["Chat pictures", "picture", "pictures"],
  exports: ["Exported videos", "video", "videos"],
  "chat-videos": ["Chat videos", "video", "videos"],
};

export const bytesLabel = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

const keepLabel = (days: number) => (days < 1 ? `each goes after ${Math.round(days * 24)} hours` : `each goes after ${days} ${days === 1 ? "day" : "days"}`);

export function keptLine(r: KeptRow): string {
  const [, one, many] = LABEL[r.kind];
  return [bytesLabel(r.bytes), r.items ? `${r.items} ${r.items === 1 ? one : many}` : "", r.keepDays ? keepLabel(r.keepDays) : ""].filter(Boolean).join(" · ");
}

/** The rows the page shows: the kinds that hold something, the biggest first. */
export const keptRows = (rows: KeptRow[]): KeptRow[] => rows.filter((r) => r.items > 0 || r.bytes > 0).sort((a, b) => b.bytes - a.bytes);

/** A row's share of everything kept, as the bar's hover text and its name for a screen reader say it. */
export const shareLabel = (bytes: number, total: number): string => {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  return `${pct > 0 && pct < 1 ? "under 1" : Math.round(pct)}% of ${bytesLabel(total)}`;
};

/** The bar under a row: this kind's share of the total. A kind that holds something always shows, however small. */
function ShareBar({ name, bytes, total }: { name: string; bytes: number; total: number }) {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  return (
    <div role="meter" aria-label={`${name}: ${shareLabel(bytes, total)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} title={shareLabel(bytes, total)} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      {bytes > 0 && <div className="h-full min-w-0.5 rounded-full bg-foreground/60" style={{ width: `${pct}%` }} />}
    </div>
  );
}

function EmptyButton({ row, onEmpty }: { row: KeptRow; onEmpty: () => Promise<void> }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant={sure ? "destructive" : "outline"}
      disabled={busy}
      onBlur={() => setSure(false)}
      onClick={() => {
        if (!sure) return setSure(true);
        setSure(false);
        setBusy(true);
        void onEmpty().finally(() => setBusy(false));
      }}
    >
      {busy ? "Emptying…" : sure ? `Delete ${bytesLabel(row.bytes)}?` : "Empty"}
    </Button>
  );
}

export function KeptSection() {
  const kept = useCachedLoad<KeptView>(KEPT_API, () => call<KeptView>(KEPT_API), { own: true });
  const [error, setError] = useState("");
  const rows = kept.data && keptRows(kept.data.rows);
  const total = rows?.reduce((n, r) => n + r.bytes, 0) ?? 0;
  const empty = async (kind: KeptKind) => {
    setError("");
    await call<KeptView>(`${KEPT_API}/${kind}/empty`, "POST").catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    await kept.refresh().catch(() => {});
  };
  return (
    <Section
      title={
        <>
          {kept.data?.here ? "Kept on this computer" : "Kept on the server"}
          {total > 0 && <span className="ml-2 font-normal text-muted-foreground">{bytesLabel(total)}</span>}
        </>
      }
    >
      <Card>
        {!kept.data && !kept.error ? (
          <LoadingRow />
        ) : !rows ? (
          <ErrorRow title="Could not read what is kept" detail={kept.error} retry={() => void kept.refresh().catch(() => {})} />
        ) : rows.length === 0 ? (
          <EmptyRow title="Nothing yet" />
        ) : (
          rows.map((r) => (
            <Row
              key={r.kind}
              title={LABEL[r.kind][0]}
              description={keptLine(r)}
              control={EMPTIED.includes(r.kind) && r.bytes > 0 ? <EmptyButton row={r} onEmpty={() => empty(r.kind)} /> : undefined}
            >
              <ShareBar name={LABEL[r.kind][0]} bytes={r.bytes} total={total} />
            </Row>
          ))
        )}
        {error && <ErrorRow title="Could not empty it" detail={error} />}
      </Card>
    </Section>
  );
}
