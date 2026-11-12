import { useState } from "react";
import { EMPTIED, type KeptKind, type KeptRow, type KeptView } from "@contracts/storage";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { call } from "./StorageRows";
import { Card, EmptyRow, ErrorRow, LoadingRow, Row, Section } from "./ui";

/**
 * "Kept on the server" (api/kept.ts): what this account keeps in the server's data folder, one row per kind with its size.
 * A chat's pictures and videos and finished renders have Empty (a second press confirms); the rest is the account's work,
 * deleted one by one in its own tool.
 */

const KEPT_API = "/api/devices/storage/kept";

const LABEL: Record<KeptKind, [title: string, one: string, many: string]> = {
  "chat-pictures": ["Chat pictures", "picture", "pictures"],
  "chat-videos": ["Chat videos", "video", "videos"],
  exports: ["Exported videos", "video", "videos"],
  analyzer: ["Analyzer posts", "post", "posts"],
  workshop: ["Workshop sources", "source", "sources"],
  captions: ["Caption Studio projects", "project", "projects"],
  review: ["Review videos", "video", "videos"],
  notes: ["Video Notes", "note", "notes"],
  enhance: ["Audio Enhancer sessions", "session", "sessions"],
};

export const bytesLabel = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

const keepLabel = (days: number) => (days < 1 ? `each goes after ${Math.round(days * 24)} hours` : `each goes after ${days} ${days === 1 ? "day" : "days"}`);

export function keptLine(r: KeptRow): string {
  const [, one, many] = LABEL[r.kind];
  return [bytesLabel(r.bytes), `${r.items} ${r.items === 1 ? one : many}`, r.keepDays ? keepLabel(r.keepDays) : ""].filter(Boolean).join(" · ");
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
  const hosted = useAuth((s) => s.hosted);
  const kept = useCachedLoad<KeptView>(KEPT_API, () => call<KeptView>(KEPT_API), { own: true });
  const [error, setError] = useState("");
  const rows = kept.data?.rows.filter((r) => r.items > 0);
  const empty = async (kind: KeptKind) => {
    setError("");
    await call<KeptView>(`${KEPT_API}/${kind}/empty`, "POST").catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    await kept.refresh().catch(() => {});
  };
  return (
    <Section title={hosted ? "Kept on the server" : "Kept on this computer"}>
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
              control={EMPTIED.includes(r.kind) ? <EmptyButton row={r} onEmpty={() => empty(r.kind)} /> : undefined}
            />
          ))
        )}
        {error && <ErrorRow title="Could not empty it" detail={error} />}
      </Card>
    </Section>
  );
}
