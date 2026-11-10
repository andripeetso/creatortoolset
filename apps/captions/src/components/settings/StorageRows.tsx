import { useEffect, useState } from "react";
import { LIBRARY_NAME, STORAGE_ROLES, THIS_COMPUTER, sourcesOf, type AddFolderBody, type Disk, type MakeLibraryBody, type SourceRole, type StorageFolder, type StorageState, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, EmptyRow, FormDialog, Row, RowMenu, SettingsSelect, Status } from "./ui";
import { msg } from "./helpers";

/** The computers an account owns (the list the Storage rows pick from). */
export type Computer = ProvidersView["devices"][number];

/** One JSON call to a storage route: the server's own sentence on a failure. */
export async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}
const STORAGE_API = "/api/devices/storage";
export const getStorage = () => call<StorageView>(STORAGE_API);
const makeLibrary = (b: MakeLibraryBody) => call<StorageState>(`${STORAGE_API}/library`, "POST", b);
const addStorageFolder = (b: AddFolderBody) => call<StorageState>(`${STORAGE_API}/folders`, "POST", b);
const removeStorageFolder = (id: string) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}`, "DELETE");

/** The drives a computer reported (its system disk, external drives, network shares). Empty until it reports one. */
export const disksOf = (d: Computer): Disk[] => d.report?.machine?.disks ?? [];
const nameOf = (devices: Computer[], host: string) =>
  host === THIS_COMPUTER ? "This computer" : (devices.find((d) => d.id === host)?.name ?? "A computer that is gone");

/** A folder as the row shows it: the computer it is on, then its full path (the Library's own Footage and Music too). */
const whereOf = (f: StorageFolder, devices: Computer[]) => `${nameOf(devices, f.origin.host)} · ${f.origin.path}`;

const size = (gb: number) => (gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`);
/** Almost full: under 20 GB free, or under a tenth of the disk. */
export const isFull = (d: { freeGb: number; totalGb?: number }) => d.freeGb < 20 || (d.totalGb !== undefined && d.freeGb / d.totalGb < 0.1);
export const spaceOf = (d: { freeGb: number; totalGb?: number }) =>
  `${size(d.freeGb)} free${d.totalGb !== undefined ? ` of ${size(d.totalGb)}` : ""}${isFull(d) ? " · almost full" : ""}`;

/** The disk a folder sits on: the longest drive path that holds it, else the system disk. A computer that reports no
 *  drives is read from the server's own disks (a local install: the computer is this machine). */
function diskOf(f: StorageFolder, devices: Computer[], serverDisks: Disk[]): Disk | undefined {
  const host = devices.find((d) => d.id === f.origin.host);
  const disks = host && !disksOf(host).length ? serverDisks : host ? disksOf(host) : [];
  const holding = disks.filter((d) => d.path !== "/" && f.origin.path.startsWith(`${d.path.replace(/\/$/, "")}/`));
  return [...holding].sort((a, b) => b.path.length - a.path.length)[0] ?? disks.find((d) => d.path === "/");
}

const roleLabel = (role: SourceRole) => STORAGE_ROLES.find((r) => r.value === role)?.label ?? role;

/**
 * Where footage, music and finished videos are kept: rows, one per place. Used by Settings → Storage and the setup's Folders
 * step. With nothing set, one row says what these folders are for; an unset row shows only its button.
 */
export function Storage({ devices, storage, onChanged }: { devices: Computer[]; storage: StorageView | null; onChanged: () => void }) {
  if (!storage) return null;
  const folders = storage.folders;
  const sources = sourcesOf(folders);
  return (
    <Card>
      {folders.length === 0 && <EmptyRow title="No folders set yet" description="Where the Media Library and the AI Editor read and save files." />}
      <LibraryRow library={folders.find((f) => f.role === "library")} devices={devices} serverDisks={storage.serverDisks} onChanged={onChanged} />
      <SourceRow role="footage" sources={sources} folders={folders} devices={devices} onChanged={onChanged} />
      <SourceRow role="music" sources={sources} folders={folders} devices={devices} onChanged={onChanged} />
    </Card>
  );
}

/** Finished videos: the Library the app saves to. Change applies from then on and moves nothing. */
function LibraryRow({ library, devices, serverDisks, onChanged }: { library?: StorageFolder; devices: Computer[]; serverDisks: Disk[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const disk = library && diskOf(library, devices, serverDisks);
  const where = library && (
    <>
      {nameOf(devices, library.origin.host)} · {library.origin.path}
      {disk && <> · {spaceOf(disk)}</>}
    </>
  );
  return (
    <>
      <Row
        id="finished-videos"
        title="Finished videos"
        description={where || undefined}
        status={library?.error ? <Status tone="broken">{library.error}</Status> : undefined}
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {library ? "Change" : "Set folder"}
          </Button>
        }
      />
      <LibraryDialog open={open} onOpenChange={setOpen} devices={devices} change={!!library} onChanged={onChanged} />
    </>
  );
}

function LibraryDialog({ open, onOpenChange, devices, change, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; devices: Computer[]; change: boolean; onChanged: () => void }) {
  const [pickHost, setPickHost] = useState("");
  const [folder, setFolder] = useState("~");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const host = devices.some((d) => d.id === pickHost) ? pickHost : devices[0]?.id ?? "";
  const where = `${folder.trim().replace(/\/+$/, "") || "~"}/${LIBRARY_NAME}`;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await makeLibrary({ host, disk: folder.trim() });
      onOpenChange(false);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => { onOpenChange(o); setErr(null); }}
      title="Finished videos"
      submitLabel={change ? "Change folder" : "Set folder"}
      onSubmit={submit}
      busy={busy}
      error={err}
    >
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a computer first.</p>
      ) : (
        <>
          <SettingsSelect label="Computer" value={host} onValueChange={setPickHost} options={devices.map((d) => ({ value: d.id, label: d.name }))} className="sm:w-full" />
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~" aria-label="Folder to put it in" />
          <p className="font-mono text-xs text-muted-foreground">{where}</p>
        </>
      )}
    </FormDialog>
  );
}

/** Footage or music: each folder's full path, "Set folder" when none and "Change" after (the dialog adds one), and a `…` menu to remove one. */
function SourceRow({ role, sources, folders, devices, onChanged }: {
  role: SourceRole; sources: StorageFolder[]; folders: StorageFolder[]; devices: Computer[]; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const mine = sources.filter((f) => f.role === role);
  const listed = mine.filter((f) => folders.some((g) => g.id === f.id));
  const label = roleLabel(role);
  const errors = listed.filter((f) => f.error);
  const remove = async (id: string) => {
    await removeStorageFolder(id);
    onChanged();
  };
  return (
    <>
      <Row
        id={role === "footage" ? "footage-folder" : "music-folder"}
        title={label}
        description={mine.length ? mine.map((f) => <span key={f.id} className="block">{whereOf(f, devices)}</span>) : undefined}
        status={
          errors.map((f) => <Status key={f.id} tone="broken">{f.error}</Status>)
        }
        control={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {mine.length ? "Change" : "Set folder"}
            </Button>
            {listed.length > 0 && (
              <RowMenu
                label={`${label} folders`}
                items={listed.map((f) => ({
                  label: `Remove ${f.name}`,
                  destructive: true,
                  confirm: { title: `Remove ${f.name}?`, body: "The folder's files stay where they are.", ok: "Remove" },
                  onSelect: () => remove(f.id),
                }))}
              />
            )}
          </div>
        }
      />
      <AddFolderDialog open={open} onOpenChange={setOpen} role={role} devices={devices} onChanged={onChanged} />
    </>
  );
}

/** "Add storage" from the Storage section: a folder you already have, as footage or music, on one of your computers. */
export function AddStorageButton({ devices, onChanged }: { devices: Computer[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}><Plus className="size-3" /> Add storage</Button>
      <AddFolderDialog open={open} onOpenChange={setOpen} devices={devices} onChanged={onChanged} />
    </>
  );
}

/** A folder you already have, as footage or music, on one of your computers. `role` picks it first; the person can change it. */
export function AddFolderDialog({ open, onOpenChange, role: first, devices, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; role?: SourceRole; devices: Computer[]; onChanged: () => void;
}) {
  const [role, setRole] = useState<SourceRole>(first ?? "footage");
  const [pickHost, setPickHost] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setRole(first ?? "footage");
    setPath("");
    setErr(null);
  }, [open, first]);
  const host = devices.some((d) => d.id === pickHost) ? pickHost : devices[0]?.id ?? "";

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await addStorageFolder({ role, host, path: path.trim() });
      onOpenChange(false);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add storage" submitLabel="Add folder" onSubmit={submit} busy={busy} error={err}>
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a computer first.</p>
      ) : (
        <>
          <SettingsSelect
            label="Used for"
            value={role}
            onValueChange={(v) => setRole(v as SourceRole)}
            options={STORAGE_ROLES.map((r) => ({ value: r.value, label: r.label }))}
            className="sm:w-full"
          />
          <SettingsSelect label="Computer" value={host} onValueChange={setPickHost} options={devices.map((d) => ({ value: d.id, label: d.name }))} className="sm:w-full" />
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Volumes/Drive/Footage" aria-label="Folder path" />
        </>
      )}
    </FormDialog>
  );
}

/** The drives of the account's computers, and this server's own when it runs on an owner's computer. Admins only (Advanced). */
export function driveList(devices: Computer[], serverDisks: Disk[]): Array<{ key: string; disk: Disk; on: string }> {
  return [
    ...devices.flatMap((d) => disksOf(d).map((disk) => ({ key: `${d.id}:${disk.path}`, disk, on: d.name }))),
    ...serverDisks.map((disk) => ({ key: `server:${disk.path}`, disk, on: "this server" })),
  ];
}

/** Whether a drive is almost full (for the Advanced summary). */
export const almostFull = (drives: Array<{ disk: Disk }>) => drives.filter((l) => isFull(l.disk)).length;
