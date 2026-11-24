import { useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowUp, ChevronLeft, Folder, HardDrive, Laptop } from "lucide-react";
import type { LibraryCopy } from "@contracts/library";
import { COPY_KIND, FOLDER_LIST_KIND } from "@contracts/devices";
import type { ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, Status, TextField } from "@/components/settings/ui";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { thisMacDevice, useProviders } from "@/lib/providers";
import { thisMacBridge } from "@/lib/thisMac";
import { bodyOf } from "@/lib/body";

/**
 * Copies (Settings → Media Library and the library's sheet, and the library's first-run screen): folders on the owner's
 * own computers that every clip is copied to (api/library/copies.ts). Only the owner sees it: the routes answer 404 to
 * anyone else, and the card is left out then. Stop copying deletes nothing in the folder. Refetched on the "library"
 * and "devices" topics (a computer's copy reports are device writes).
 */

type Computer = ProvidersView["devices"][number];

const ask = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init).catch(() => null);
  const body = (r && (await bodyOf(r))) as T & { error?: string };
  if (!r?.ok) throw Object.assign(new Error(body?.error ?? "Could not reach the server. Try again."), { status: r?.status });
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
    c.state === "full" && "Disk full on the computer",
    c.offlineSince && `Offline since ${since(c.offlineSince, now)}`,
    c.waitsFor && `Waits for ${c.waitsFor}`,
    !!c.noOriginal && `No original for ${c.noOriginal} ${c.noOriginal === 1 ? "file" : "files"}`,
    c.needsUpload && "Needs Upload to the server",
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
                actions={!c.readOnly && <RowMenu label="Copy options" items={items} />}
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

/** A computer of this account's that cannot take a copy yet, and what it needs (null when it can). */
const computerNeeds = (d: Computer) =>
  !(d.kinds?.includes(FOLDER_LIST_KIND) && d.kinds.includes(COPY_KIND))
    ? (d.report?.machine?.os ?? "mac") === "mac"
      ? "Needs the Mac app updated"
      : "Needs an update"
    : !d.online
      ? `Needs ${d.name} online`
      : null;

/** Folders a copy can never go to: the top of the disk and the Mac's list of disks. */
const NOT_A_FOLDER = ["/", "/Volumes"];

/** Add copy: a computer of this account's that can list its folders, then a folder on it. */
function AddCopy({ libraryId, onClose, onAdded }: { libraryId: string; onClose: () => void; onAdded: (c: LibraryCopy) => void }) {
  const me = useAuth((s) => s.me?.username);
  const providers = useProviders();
  const computers = (providers.data?.devices ?? []).filter((d) => d.owner === me);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [path, setPath] = useState("/");
  // the list on screen and the folder it is of: kept (dimmed) while the next one loads, so nothing moves under the pointer
  const [shown, setShown] = useState<{ at: string; folders: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);

  const open = async (d: Computer, at: string) => {
    const clean = at.replace(/\/+$/, "") || "/";
    const n = ++last.current;
    if (d.id !== computer?.id) setShown(null);
    setComputer(d);
    setPath(clean);
    setLoading(true);
    setListError(null);
    try {
      const b = await ask<{ folders: string[] }>(`/api/library/${libraryId}/copies/folders?device=${encodeURIComponent(d.id)}&path=${encodeURIComponent(clean)}`);
      if (n !== last.current) return;
      setShown({ at: clean, folders: b.folders.map((f) => f.split("/").filter(Boolean).pop() ?? f).sort((a, b) => a.localeCompare(b)) });
    } catch (e) {
      if (n === last.current) setListError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === last.current) setLoading(false);
    }
  };
  const into = (from: string, name: string) => (from === "/" ? `/${name}` : `${from}/${name}`);
  const up = (from: string) => from.slice(0, from.lastIndexOf("/")) || "/";
  const crumbs = path.split("/").filter(Boolean);
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
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add copy"
      submitLabel="Copy to this folder"
      onSubmit={add}
      busy={busy}
      submitDisabled={!computer || NOT_A_FOLDER.includes(path)}
      error={error}
    >
      {!computer ? (
        <Card>
          {providers.error && !providers.data ? (
            <ErrorRow title="Could not load computers" retry={() => void providers.refresh().catch(() => {})} />
          ) : !providers.data ? (
            <LoadingRow />
          ) : computers.length === 0 ? (
            <>
              <EmptyRow title="No computers yet" />
              <div className="px-3 pb-3 sm:px-4">
                <Button asChild size="sm" variant="outline">
                  <Link to="/settings/devices?add=1" onClick={onClose}>
                    Add computer
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            computers.map((d) => {
              const needs = computerNeeds(d);
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={!!needs}
                  className="block w-full text-left enabled:hover:bg-muted/50 disabled:cursor-default"
                  onClick={() => void open(d, (d.report?.machine?.os ?? "mac") === "mac" ? "/Volumes" : "/")}
                >
                  <ListRow icon={<Laptop />} title={d.name} status={needs && <Status tone="attention">{needs}</Status>} />
                </button>
              );
            })
          )}
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-0.5 text-sm">
            <Button type="button" variant="ghost" size="sm" onClick={() => setComputer(null)}>
              <ChevronLeft />
              Computers
            </Button>
            <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center text-muted-foreground">
              <button type="button" className="rounded px-1 hover:text-foreground" onClick={() => void open(computer, "/")}>
                {computer.name}
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center">
                  <span aria-hidden>/</span>
                  <button type="button" className="rounded px-1 hover:text-foreground" onClick={() => void open(computer, `/${crumbs.slice(0, i + 1).join("/")}`)}>
                    {c}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <TextField label="Folder" value={path} onCommit={(p) => open(computer, p.startsWith("/") ? p : `/${p}`)} />
          <Card className="max-h-64 overflow-y-scroll">
            {listError ? (
              <ErrorRow title="Could not load folders" detail={listError} retry={() => void open(computer, path)} />
            ) : !shown ? (
              <LoadingRow />
            ) : (
              <div aria-busy={loading} className={loading ? "opacity-50 transition-opacity" : "transition-opacity"}>
                {shown.at !== "/" && (
                  <button type="button" className="block w-full text-left hover:bg-muted/50" onClick={() => void open(computer, up(shown.at))}>
                    <ListRow icon={<ArrowUp />} title="Up" />
                  </button>
                )}
                {shown.folders.length === 0 ? (
                  <EmptyRow title="Nothing here yet" />
                ) : (
                  shown.folders.map((f) => (
                    <button key={f} type="button" className="block w-full text-left hover:bg-muted/50" onClick={() => void open(computer, into(shown.at, f))}>
                      <ListRow icon={<Folder />} title={f} />
                    </button>
                  ))
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </FormDialog>
  );
}
