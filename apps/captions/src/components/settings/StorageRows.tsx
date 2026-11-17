import { useEffect, useRef, useState } from "react";
import { EVERY_WORKSPACE, LIBRARY_NAME, THIS_COMPUTER, connectFor, finalsFolderOf, sourcesOf, type AddFolderBody, type Disk, type MakeLibraryBody, type MoveFolderBody, type StorageFolder, type StorageState, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBigFolder } from "@/components/LibraryProcessing";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWorkspace } from "@/lib/workspace";
import { chooseFolderOnMac, macImports } from "@/lib/thisMac";
import { Card, FormDialog, ListRow, Row, RowMenu, SettingsDialog, SettingsDialogContent, SettingsSelect, Status, WorkspaceTag, WorkspacesDialog, inWorkspace, saveFailed, type SettingsWorkspace } from "./ui";
import { msg } from "./helpers";

/** The computers an account owns (the list the Storage rows pick from). */
export type Computer = ProvidersView["devices"][number];

/** One JSON call to a storage route: the server's own sentence on a failure. `workspace`: the one the call works in, when it is not the window's. */
export async function call<T>(url: string, method = "GET", body?: unknown, workspace?: string | null): Promise<T> {
  const r = await fetch(url, inWorkspace(workspace, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}
export const STORAGE_API = "/api/devices/storage";
/** Every workspace's folders (Settings → Folders on All workspaces). */
export const STORAGE_ALL = `${STORAGE_API}?all=1`;
export const getStorage = () => call<StorageView>(STORAGE_API);
// a new folder goes to the workspace the call works in; one is moved or removed by its id, whatever workspace it is in
const makeLibrary = (b: MakeLibraryBody, workspace?: string | null) => call<StorageState>(`${STORAGE_API}/library`, "POST", b, workspace);
const addStorageFolder = (b: AddFolderBody, workspace?: string | null) => call<StorageState>(`${STORAGE_API}/folders`, "POST", b, workspace);
const moveStorageFolder = (id: string, workspaces: string[] | null) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}`, "PATCH", { workspaces } satisfies MoveFolderBody);
const removeStorageFolder = (id: string) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}`, "DELETE");

/** The drives a computer reported (its system disk, external drives, network shares). Empty until it reports one. */
export const disksOf = (d: Computer): Disk[] => d.report?.machine?.disks ?? [];
/** The drives a folder on `host` can be on: that computer's, or the server's own when it reports none (a local install). */
export const disksFor = (devices: Computer[], host: string, serverDisks: Disk[] = []): Disk[] => {
  const d = devices.find((x) => x.id === host);
  return d && disksOf(d).length ? disksOf(d) : serverDisks;
};
const nameOf = (devices: Computer[], host: string) =>
  host === THIS_COMPUTER ? "This computer" : (devices.find((d) => d.id === host)?.name ?? "Computer not found");

/** A folder as the row shows it: the computer it is on, then its full path (the Library's own Footage and Music too). */
const whereOf = (f: StorageFolder, devices: Computer[]) => `${nameOf(devices, f.origin.host)} · ${f.origin.path}`;

const size = (gb: number) => (gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`);
/** Almost full: under 20 GB free, or under a tenth of the disk. */
export const isFull = (d: { freeGb: number; totalGb?: number }) => d.freeGb < 20 || (d.totalGb !== undefined && d.freeGb / d.totalGb < 0.1);
/** "29 GB free of 460 GB", and an amber "almost full" after it on the drive that is (`mark` false: the row says so itself). */
export const spaceOf = (d: { freeGb: number; totalGb?: number }, mark = true) => (
  <>
    {size(d.freeGb)} free{d.totalGb !== undefined && ` of ${size(d.totalGb)}`}
    {mark && isFull(d) && <span className="text-amber-600 dark:text-amber-400"> · almost full</span>}
  </>
);

/** The disk a folder sits on: the longest drive path that holds it, else the system disk. A computer that reports no
 *  drives is read from the server's own disks (a local install: the computer is this machine). */
function diskOf(f: StorageFolder, devices: Computer[], serverDisks: Disk[]): Disk | undefined {
  const host = devices.find((d) => d.id === f.origin.host);
  const disks = host && !disksOf(host).length ? serverDisks : host ? disksOf(host) : [];
  const holding = disks.filter((d) => d.path !== "/" && f.origin.path.startsWith(`${d.path.replace(/\/$/, "")}/`));
  return [...holding].sort((a, b) => b.path.length - a.path.length)[0] ?? disks.find((d) => d.path === "/");
}

/** A drive as the Drive select names it: "BABY ACROBATICS · nas-name · 2.8 TB free" (a network share says whose it is). */
export const driveLabel = (d: Disk) => `${d.name}${d.network ? ` · ${d.server && d.server !== d.name ? d.server : "Network"}` : ""} · ${size(d.freeGb)} free`;
/** Where a folder field starts once a drive is picked: the home folder on the system disk, else the drive's own folder. */
export const driveStart = (d: Disk) => (d.path === "/" ? "~" : d.path.replace(/\/+$/, ""));
/** The drive a typed path is on: the longest drive folder that holds it; "~" and any other full path are the system disk. */
export function driveOf(disks: readonly Disk[], typed: string): Disk | undefined {
  const p = typed.trim();
  if (!p) return undefined;
  const under = (d: Disk) => d.path !== "/" && (p === d.path.replace(/\/+$/, "") || p.startsWith(`${d.path.replace(/\/+$/, "")}/`));
  const holding = disks.filter(under).sort((a, b) => b.path.length - a.path.length)[0];
  return holding ?? (p.startsWith("/") || p.startsWith("~") ? disks.find((d) => d.path === "/") : undefined);
}

const NO_DRIVE = "no-drive";
const CONNECT = "connect-network-storage";

/**
 * What a person types for a network share, as the address Finder connects to: "nas.local/Footage", "\\nas\Footage" and
 * "smb://nas.local/My Footage" all become smb://…, with spaces written the way an address needs. Only smb and afp are
 * taken (the address becomes a link, so nothing else may get through); null for anything that is not a share.
 */
export function shareAddress(typed: string): string | null {
  const t = typed.trim().replace(/\\/g, "/");
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(t);
  const scheme = m ? m[1].toLowerCase() : "smb";
  const rest = (m ? m[2] : t).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!["smb", "afp"].includes(scheme) || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?(\/.+)?$/i.test(rest)) return null;
  let plain = rest;
  try {
    plain = decodeURI(rest);
  } catch {
    /* a stray % in a share's name: taken as typed */
  }
  return `${scheme}://${encodeURI(plain)}`;
}

/** A link like smb:// only opens Finder on a Mac: the page offers Connect there and nowhere else. */
const onMac = () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/**
 * The drives of the chosen computer (its system disk, external drives, network shares), above a folder field: picking one
 * starts the path there, and a typed path shows the drive it is on. Nothing is shown for a computer that reported none.
 * On a Mac the list ends with "Connect network storage…": an address, and Connect hands it to Finder on this Mac, which
 * asks for the share's name and password itself. While that form is open the drives are read again every few seconds
 * (`onLook`), and a share that appears is picked.
 */
export function DriveSelect({ disks, path, onPick, onLook }: { disks: readonly Disk[]; path: string; onPick: (start: string) => void; onLook?: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState("");
  const known = useRef<string[] | null>(null);
  useEffect(() => {
    if (!connecting || !onLook) return;
    const t = window.setInterval(onLook, 5000);
    return () => window.clearInterval(t);
  }, [connecting, onLook]);
  // the share Finder just connected: the first network drive that was not in the list when the form opened
  useEffect(() => {
    if (!connecting) {
      known.current = null;
      return;
    }
    if (!known.current) known.current = disks.map((d) => d.path);
    const fresh = disks.find((d) => d.network && !known.current!.includes(d.path));
    if (!fresh) return;
    onPick(driveStart(fresh));
    setConnecting(false);
    setAddress("");
  }, [connecting, disks, onPick]);
  if (disks.length === 0) return null;
  const on = driveOf(disks, path);
  const href = shareAddress(address);
  return (
    <>
      <SettingsSelect
        label="Drive"
        value={connecting ? CONNECT : (on?.path ?? NO_DRIVE)}
        onValueChange={(v) => {
          setConnecting(v === CONNECT);
          const d = disks.find((x) => x.path === v);
          if (d) onPick(driveStart(d));
        }}
        options={[
          ...(on || connecting ? [] : [{ value: NO_DRIVE, label: "Choose a drive" }]),
          ...disks.map((d) => ({ value: d.path, label: driveLabel(d) })),
          ...(onMac() ? [{ value: CONNECT, label: "Connect network storage…" }] : []),
        ]}
        className="sm:w-full"
      />
      {connecting && (
        <>
          <div className="flex items-center gap-2">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="smb://nas.local/Footage" aria-label="Network storage address" autoFocus />
            {href ? (
              <Button asChild type="button" size="sm" variant="outline">
                <a href={href}>Connect</a>
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" disabled>
                Connect
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Finder asks for its name and password.</p>
        </>
      )}
    </>
  );
}

/** The workspaces a folder is in, as its tag and its Workspaces name them: null for one every workspace uses. */
const workspacesOf = (f: StorageFolder) => (f.workspace === EVERY_WORKSPACE ? null : (f.workspaces ?? (f.workspace ? [f.workspace] : [])));

/**
 * Where finished videos, footage and music are kept: Exports is one folder per workspace, the Media folders any
 * number, each folder a row with its menu. Used by Settings → Folders and the setup's Folders step.
 * `w`: the workspace Settings shows (workspace-pick.tsx). With all of them shown each row carries its workspace and
 * Finished videos has a row per workspace; left out (setup), the rows are the window's workspace's.
 */
export function Storage({ devices, storage, onChanged, w }: { devices: Computer[]; storage: StorageView | null; onChanged: () => void; w?: SettingsWorkspace }) {
  if (!storage) return null;
  const libraries = storage.folders.filter((f) => f.role === "library");
  const each = w?.all ? w.workspaces.map((p) => ({ id: p.id as string | null, library: libraries.find((f) => f.workspace === p.id) })) : [{ id: w?.id ?? null, library: libraries[0] }];
  // one that no listed workspace has (another account's workspace, a second one in one workspace) still shows
  const rest = w?.all ? libraries.filter((f) => !each.some((r) => r.library === f)).map((f) => ({ id: f.workspace ?? null, library: f })) : [];
  const shared = { devices, serverDisks: storage.serverDisks, onChanged };
  return (
    <Card>
      {[...each, ...rest].map((r, i) => (
        <LibraryRow key={r.library?.id ?? r.id ?? "own"} first={i === 0} workspace={r.id} tagged={!!w?.all} library={r.library} {...shared} />
      ))}
      {each.map((r, i) => (
        <FinalsRow key={r.id ?? "own"} first={i === 0} workspace={r.id} w={w} here={storage.here} folders={w?.all ? storage.folders.filter((f) => f.workspace === r.id) : storage.folders} {...shared} />
      ))}
      <SourceRows storage={storage} w={w} {...shared} />
    </Card>
  );
}

/** Finished videos: the Library the app saves to, one per workspace. Change applies from then on and moves nothing. */
function LibraryRow({ library, workspace, tagged, first, devices, serverDisks, onChanged }: {
  library?: StorageFolder; workspace: string | null; tagged: boolean; first: boolean; devices: Computer[]; serverDisks: Disk[]; onChanged: () => void;
}) {
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
        id={first ? "finished-videos" : undefined}
        title="Exports"
        description={where || "Where finished edits are saved. A Creator Toolset folder is made in the folder you pick."}
        status={
          tagged || library?.error ? (
            <span className="flex flex-col gap-0.5">
              {tagged && <WorkspaceTag id={workspace} />}
              {library?.error && <Status tone="broken">{library.error}</Status>}
            </span>
          ) : undefined
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {library ? "Change" : "Add folder"}
          </Button>
        }
      />
      <LibraryDialog open={open} onOpenChange={setOpen} devices={devices} serverDisks={serverDisks} change={!!library} workspace={workspace} onChanged={onChanged} />
    </>
  );
}

function LibraryDialog({ open, onOpenChange, devices, serverDisks, change, workspace, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; devices: Computer[]; serverDisks: Disk[]; change: boolean; workspace: string | null; onChanged: () => void;
}) {
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
      await makeLibrary({ host, disk: folder.trim() }, workspace);
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
      title="Exports"
      submitLabel={change ? "Change folder" : "Add folder"}
      onSubmit={submit}
      busy={busy}
      submitDisabled={devices.length === 0}
      error={err}
    >
      {devices.length === 0 ? (
        <Status tone="attention">Needs a computer</Status>
      ) : (
        <>
          <SettingsSelect label="Computer" value={host} onValueChange={setPickHost} options={devices.map((d) => ({ value: d.id, label: d.name }))} className="sm:w-full" />
          <DriveSelect disks={disksFor(devices, host, serverDisks)} path={folder} onPick={setFolder} onLook={onChanged} />
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~" aria-label="Folder" />
          <p className="font-mono text-xs text-muted-foreground">{where}</p>
        </>
      )}
    </FormDialog>
  );
}

/**
 * Finals: where each Workshop project's finished video goes, a folder per project, read into Finals (one per workspace;
 * the Library's Finished/ until another is chosen). Change applies from then on and moves nothing.
 */
function FinalsRow({ folders, workspace, first, w, here, devices, serverDisks, onChanged }: {
  folders: StorageFolder[]; workspace: string | null; first: boolean; w?: SettingsWorkspace; here?: string[]; devices: Computer[]; serverDisks: Disk[]; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const f = finalsFolderOf(folders);
  return (
    <>
      <Row
        id={first ? "finals-folder" : undefined}
        title="Finals"
        description={f ? whereOf(f, devices) : undefined}
        status={w?.all ? <WorkspaceTag id={workspace} /> : undefined}
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {f ? "Change" : "Add folder"}
          </Button>
        }
      />
      <AddFolderDialog open={open} onOpenChange={setOpen} role="finals" devices={devices} serverDisks={serverDisks} here={here} w={w && { ...w, id: workspace, many: false }} onChanged={onChanged} />
    </>
  );
}

/**
 * The folders the Media Library takes in (footage, music, sound effects: the Library sorts them), under one row with
 * Add folder, each folder indented under it (a music folder from before is one of them: api/lib/storage.ts).
 */
function SourceRows({ storage, devices, serverDisks, w, onChanged }: {
  storage: StorageView; devices: Computer[]; serverDisks: Disk[]; w?: SettingsWorkspace; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const mine = sourcesOf(storage.folders);
  return (
    <>
      <Row
        id="footage-folder"
        title="Media"
        description="Footage, music and sound effects. The Media Library takes in everything in these folders."
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Add folder
          </Button>
        }
      />
      {mine.map((f) => (
        <FolderRow key={f.id} folder={f} storage={storage} devices={devices} w={w} onChanged={onChanged} />
      ))}
      <AddFolderDialog open={open} onOpenChange={setOpen} role="footage" devices={devices} serverDisks={serverDisks} here={storage.here} w={w} onChanged={onChanged} />
    </>
  );
}

/**
 * One footage or music folder: its name, the computer it is on and its full path, its workspace while every workspace
 * is shown, and its menu: Workspaces (any of them, or all), Remove.
 */
function FolderRow({ folder: f, storage, devices, w, onChanged }: { folder: StorageFolder; storage: StorageView; devices: Computer[]; w?: SettingsWorkspace; onChanged: () => void }) {
  // the Library's own Footage and Music come with the Finished videos folder: they are not moved or removed here
  const own = !f.id.includes(":");
  // the folder's workspace keeps copies on the server: asked per folder when every workspace is listed
  const copies = storage.copied ? storage.copied.includes(f.id.split(":")[0]!) : storage.copies;
  const tagged = !!w?.all;
  const [picking, setPicking] = useState(false);
  return (
    <>
    <ListRow
      className="pl-8 sm:pl-10"
      title={f.name}
      subtitle={<span title={f.origin.path}>{whereOf(f, devices)}</span>}
      status={
        tagged || f.error || devices.length > 1 ? (
          <span className="flex flex-col gap-0.5">
            {tagged && <WorkspaceTag id={workspacesOf(f)} />}
            {f.error && <Status tone="broken">{f.error}</Status>}
            <FolderReach folder={f} devices={devices} copies={copies} />
          </span>
        ) : undefined
      }
      actions={
        own ? (
          <RowMenu
            label={`Actions for ${f.name}`}
            items={[
              ...(w?.many ? [{ label: "Workspaces", onSelect: () => setPicking(true) }] : []),
              {
                label: "Remove",
                destructive: true,
                confirm: { title: `Remove ${f.name}?`, body: "The folder's files are not deleted.", ok: "Remove" },
                onSelect: () => removeStorageFolder(f.id).then(onChanged),
              },
            ]}
          />
        ) : undefined
      }
    />
    {picking && w && (
      <WorkspacesDialog
        title={`Workspaces that use ${f.name}`}
        workspaces={w.workspaces}
        on={workspacesOf(f)}
        save={(to) => moveStorageFolder(f.id, to).then(onChanged, (e: Error) => (saveFailed(e.message), Promise.reject(e)))}
        onClose={() => setPicking(false)}
      />
    )}
    </>
  );
}

/**
 * Which of the account's computers can read a folder, and how: on its own disks, through the copy the server keeps
 * (the Media Library uploads), or not at all yet. One that isn't connected gets Connect when the folder is on a share.
 * Nothing with one computer.
 */
function FolderReach({ folder, devices, copies }: { folder: StorageFolder; devices: Computer[]; copies?: boolean }) {
  const [connect, setConnect] = useState<Computer | null>(null);
  if (devices.length < 2) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {devices.map((d) => {
        const has = folder.origin.host === d.id || !!folder.reach[d.id];
        const os = d.report?.machine?.os;
        const how = !has && folder.mount && os ? connectFor(folder.mount, os) : null;
        return (
          <span key={d.id} className="inline-flex items-center gap-1.5">
            <Status tone={has ? "ok" : copies ? undefined : "attention"}>
              {d.name} · {has ? "On this computer" : copies ? "Through the server copy" : "Not connected"}
            </Status>
            {how && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConnect(d)}>
                Connect
              </Button>
            )}
          </span>
        );
      })}
      {connect && folder.mount && <ConnectDialog folder={folder} computer={connect} onClose={() => setConnect(null)} />}
    </span>
  );
}

/** How to connect a folder's share on one computer: the Finder link on a Mac, the one line to run on Linux or Windows.
 *  `onUsed`: Open or Copy was pressed (the Help screen checks the computer's drives again). */
export function ConnectDialog({ folder, computer, onClose, onUsed }: { folder: StorageFolder; computer: Computer; onClose: () => void; onUsed?: () => void }) {
  const how = connectFor(folder.mount!, computer.report?.machine?.os ?? "mac");
  const where = `${folder.mount!.server}/${folder.mount!.share}`;
  return (
    <SettingsDialog open onOpenChange={(o) => !o && onClose()}>
      <SettingsDialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Connect {folder.name} on {computer.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {how && "url" in how ? (
            <>
              <p>Open the shared drive {where} on {computer.name}.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">{how.url}</code>
                <Button size="sm" variant="outline" asChild>
                  <a href={how.url} onClick={onUsed}>Open</a>
                </Button>
              </div>
            </>
          ) : how ? (
            <>
              <p>Run this on {computer.name}.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">{how.line}</code>
                <Button size="sm" variant="outline" onClick={() => (void navigator.clipboard?.writeText(how.line), onUsed?.())}>
                  Copy
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </SettingsDialogContent>
    </SettingsDialog>
  );
}

/**
 * A folder the person already has, as footage or music, on a drive of one of the account's computers. With two or more
 * workspaces the first field is the workspace it is for: the one Settings shows, else the window's.
 */
function AddFolderDialog({ open, onOpenChange, role, devices, serverDisks, here = [], w, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; role: AddFolderBody["role"]; devices: Computer[]; serverDisks?: Disk[]; here?: string[]; w?: SettingsWorkspace; onChanged: () => void;
}) {
  // `here`: the computers that are the machine this server runs on. A folder added on one joins the Media Library,
  // which transcribes and describes every clip, so a big one shows what that takes before it is added
  const big = useBigFolder();
  const windowIn = useWorkspace((s) => s.currentProjectId);
  const [pickWorkspace, setPickWorkspace] = useState("");
  const [pickHost, setPickHost] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPickWorkspace("");
    setPath("");
    setErr(null);
  }, [open]);
  const host = devices.some((d) => d.id === pickHost) ? pickHost : devices[0]?.id ?? "";
  const known = (id?: string | null) => (id && w?.workspaces.some((p) => p.id === id) ? id : null);
  const workspace = known(pickWorkspace) ?? known(w?.id) ?? known(windowIn) ?? w?.workspaces[0]?.id ?? null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const p = path.trim();
    const add = async () => {
      try {
        await addStorageFolder({ role, host, path: p }, workspace);
        onOpenChange(false);
        onChanged();
      } catch (x) {
        setErr(msg(x));
      }
    };
    try {
      // a Finals folder is read project by project, never taken in whole
      if (role !== "finals" && here.includes(host)) await big.check(p, add);
      else await add();
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={role === "finals" ? "Finals folder" : "Add folder"} submitLabel={role === "finals" ? "Change folder" : "Add folder"} onSubmit={submit} busy={busy} submitDisabled={devices.length === 0} error={err}>
      {devices.length === 0 ? (
        <Status tone="attention">Needs a computer</Status>
      ) : (
        <>
          {w?.many && workspace && (
            <SettingsSelect label="Workspace" value={workspace} onValueChange={setPickWorkspace} options={w.workspaces.map((p) => ({ value: p.id, label: p.name }))} className="sm:w-full" />
          )}
          <SettingsSelect label="Computer" value={host} onValueChange={setPickHost} options={devices.map((d) => ({ value: d.id, label: d.name }))} className="sm:w-full" />
          <DriveSelect disks={disksFor(devices, host, serverDisks)} path={path} onPick={setPath} onLook={onChanged} />
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={role === "finals" ? "/Volumes/Drive/Finals" : "/Volumes/Drive/Footage"} aria-label="Folder path" required />
          {/* chosen in the Mac app's picker, the Mac app may copy a dropped final into it */}
          {role === "finals" && macImports() && (
            <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void chooseFolderOnMac().then((p) => p && setPath(p))}>
              Choose folder
            </Button>
          )}
        </>
      )}
      {big.dialog}
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
