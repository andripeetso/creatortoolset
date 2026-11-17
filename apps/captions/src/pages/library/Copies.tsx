import { useState } from "react";
import { ArrowUp, ChevronLeft, Folder, HardDrive, Laptop } from "lucide-react";
import type { LibraryCopy } from "@contracts/library";
import { FOLDER_LIST_KIND } from "@contracts/devices";
import type { ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, Status, TextField } from "@/components/settings/ui";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { thisMacDevice, useProviders } from "@/lib/providers";
import { thisMacBridge } from "@/lib/thisMac";

/**
 * Copies (Settings → Media Library and the library's sheet, and the library's first-run screen): folders on the owner's
 * own computers that every clip is copied to (api/library/copies.ts). Only the owner sees it: the routes answer 404 to
 * anyone else, and the card is left out then. Stop copying deletes nothing in the folder. Refetched on the "library"
 * and "devices" topics (a computer's copy reports are device writes).
 */

type Computer = ProvidersView["devices"][number];

const ask = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init);
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(body.error ?? `Request failed (${r.status})`), { status: r.status });
  return body;
};

/** The copies, or null when this account is not the library's owner (404). */
const listCopies = (library: string) =>
  ask<{ copies: LibraryCopy[] }>(`/api/library/${library}/copies`).then(
    (b) => b.copies,
    (e: Error & { status?: number }) => {
      if (e.status === 404) return null;
      throw e;
    },
  );

/** "14:05" today, else the date. */
const since = (t: number, now = Date.now()) =>
  new Date(t).toDateString() === new Date(now).toDateString()
    ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A copy's line while it is busy, and what it needs (none while it is fine). */
export function copyLines(c: LibraryCopy, now = Date.now()): { busy: string | null; needs: string[] } {
  const busy = c.pending > 0 ? `Copying ${c.pending} ${c.pending === 1 ? "file" : "files"}` : c.copying ? "Copying" : null;
  const needs = [
    c.state === "reconnect" && "Needs the folder reconnected",
    c.state === "full" && "Disk full",
    c.offlineSince && `Offline since ${since(c.offlineSince, now)}`,
    c.waitsFor && `Needs ${c.waitsFor} online`,
  ].filter((x): x is string => !!x);
  return { busy, needs };
}

/** Show in Finder for a copy on this very Mac: needs a Mac app that says it shows copy folders (its mark). */
const canShow = (c: LibraryCopy) =>
  !!thisMacBridge() && thisMacDevice() === c.device && typeof document !== "undefined" && document.documentElement.dataset.macCopyReveal === "1";

export function LibraryCopies({ libraryId, className }: { libraryId: string; className?: string }) {
  const url = `/api/library/${libraryId}/copies`;
  const copies = useCachedLoad<LibraryCopy[] | null>(url, () => listCopies(libraryId), { topic: ["library", "devices"], own: true });
  const [adding, setAdding] = useState(false);
  const list = copies.data;
  // nothing before the first answer, or for anyone but the owner (null): the card never flashes up for them
  if (!list && !copies.error) return null;
  const stop = async (c: LibraryCopy) => {
    await ask(`${url}/${c.id}`, { method: "DELETE" });
    copies.set((all) => all?.filter((x) => x.id !== c.id) ?? all);
  };
  const show = async (c: LibraryCopy) => {
    const r = (await thisMacBridge()!.postMessage(`reveal:${JSON.stringify({ library: libraryId, copy: c.id, path: c.path })}`)) as unknown as { ok?: boolean; problem?: string };
    if (!r?.ok) throw new Error(r?.problem ?? "Folder not found on this Mac");
  };
  return (
    <Section
      title="Copies"
      className={className}
      action={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          Add copy
        </Button>
      }
    >
      <Card>
        {!list ? (
          <ErrorRow title="Could not load copies" retry={() => void copies.refresh().catch(() => {})} />
        ) : list.length === 0 ? (
          <EmptyRow title="No copies" />
        ) : (
          list.map((c) => {
            const { busy, needs } = copyLines(c);
            const items = [
              ...(canShow(c) ? [{ label: "Show in Finder", onSelect: () => show(c) }] : []),
              { label: "Stop copying", onSelect: () => stop(c) },
            ];
            return (
              <ListRow
                key={c.id}
                icon={<HardDrive />}
                title={<span title={c.path}>{`${c.computer} · ${c.path}`}</span>}
                subtitle={busy}
                status={
                  needs.length > 0 && (
                    <span className="flex flex-wrap gap-x-3">
                      {needs.map((n) => (
                        <Status key={n} tone="attention">
                          {n}
                        </Status>
                      ))}
                    </span>
                  )
                }
                actions={!c.readOnly && <RowMenu label="Copy" items={items} />}
              />
            );
          })
        )}
      </Card>
      {adding && (
        <AddCopy
          libraryId={libraryId}
          onClose={() => setAdding(false)}
          onAdded={(c) => {
            copies.set((all) => [...(all ?? []), c]);
            setAdding(false);
          }}
        />
      )}
    </Section>
  );
}

/** Add copy: a computer of this account's that can list its folders, then a folder on it. */
function AddCopy({ libraryId, onClose, onAdded }: { libraryId: string; onClose: () => void; onAdded: (c: LibraryCopy) => void }) {
  const me = useAuth((s) => s.me?.username);
  const providers = useProviders();
  const computers = (providers.data?.devices ?? []).filter((d) => d.owner === me && d.kinds?.includes(FOLDER_LIST_KIND));
  const [computer, setComputer] = useState<Computer | null>(null);
  const [path, setPath] = useState("/");
  const [folders, setFolders] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (d: Computer, at: string) => {
    const clean = at.replace(/\/+$/, "") || "/";
    setComputer(d);
    setPath(clean);
    setFolders(null);
    setListError(null);
    try {
      const b = await ask<{ folders: string[] }>(`/api/library/${libraryId}/copies/folders?device=${encodeURIComponent(d.id)}&path=${encodeURIComponent(clean)}`);
      setFolders(b.folders.map((f) => f.split("/").filter(Boolean).pop() ?? f).sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  };
  const into = (name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);
  const up = path.slice(0, path.lastIndexOf("/")) || "/";
  const add = async () => {
    if (!computer) return;
    setBusy(true);
    setError(null);
    try {
      const { copy } = await ask<{ copy: LibraryCopy }>(`/api/library/${libraryId}/copies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device: computer.id, path }),
      });
      onAdded(copy);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Add copy" submitLabel="Add copy" onSubmit={add} busy={busy} submitDisabled={!computer} error={error}>
      {!computer ? (
        <Card>
          {providers.error && !providers.data ? (
            <ErrorRow title="Could not load computers" retry={() => void providers.refresh().catch(() => {})} />
          ) : !providers.data ? (
            <LoadingRow />
          ) : computers.length === 0 ? (
            <EmptyRow title="No computers" />
          ) : (
            computers.map((d) => (
              <button key={d.id} type="button" className="block w-full text-left hover:bg-muted/50" onClick={() => void open(d, (d.report?.machine?.os ?? "mac") === "mac" ? "/Volumes" : "/")}>
                <ListRow icon={<Laptop />} title={d.name} status={!d.online && <Status>Offline</Status>} />
              </button>
            ))
          )}
        </Card>
      ) : (
        <>
          <Button type="button" variant="ghost" size="sm" onClick={() => setComputer(null)}>
            <ChevronLeft />
            {computer.name}
          </Button>
          <TextField label="Folder" value={path} onCommit={(p) => open(computer, p.startsWith("/") ? p : `/${p}`)} />
          <Card className="max-h-64 overflow-y-auto">
            {path !== "/" && (
              <button type="button" className="block w-full text-left hover:bg-muted/50" onClick={() => void open(computer, up)}>
                <ListRow icon={<ArrowUp />} title="Up" />
              </button>
            )}
            {listError ? (
              <ErrorRow title="Could not load folders" detail={listError} retry={() => void open(computer, path)} />
            ) : !folders ? (
              <LoadingRow />
            ) : folders.length === 0 ? (
              <EmptyRow title="No folders" />
            ) : (
              folders.map((f) => (
                <button key={f} type="button" className="block w-full text-left hover:bg-muted/50" onClick={() => void open(computer, into(f))}>
                  <ListRow icon={<Folder />} title={f} />
                </button>
              ))
            )}
          </Card>
        </>
      )}
    </FormDialog>
  );
}
