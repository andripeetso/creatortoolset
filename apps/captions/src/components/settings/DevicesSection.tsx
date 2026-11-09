import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Folder, HardDrive, Laptop, Monitor, MoreHorizontal, Plus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { getProviders, removeDevice, renameDevice } from "@/lib/providers";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, TOOL_NAMES, runsOn, type Balance, type Machine, type ProvidersView } from "@contracts/providers";
import { LIBRARY_NAME, STORAGE_ROLES, sourcesOf, type AddFolderBody, type Disk, type MakeLibraryBody, type SourceRole, type StorageFolder, type StorageState, type StorageView } from "@contracts/storage";
import { devicesSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Card, Dot, Group, Loading, Notice } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

type Device = ProvidersView["devices"][number];

/** Settings → Devices: one card of the computers that run this account's AI (and the workspace's, for admins), each with a … menu to rename or remove it, then the Storage group. */
export function DevicesSection() {
  const me = useAuth((s) => s.me);
  const [view, setView] = useState<ProvidersView | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    getProviders()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(msg(e)));
    getStorage().then(setStorage).catch(() => setStorage(null));
    getBalance().then(setBalance).catch(() => setBalance(null));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !view) return <Notice tone="error">Could not load devices: {error}</Notice>;
  if (!view || !me) return <Loading />;

  const computers = view.devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));
  // storage is this account's own: only its own computers can hold its folders
  const own = view.devices.filter((d) => d.owner === me.username);

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <Group title="Computers" action={<AddComputer />}>
        <Card>
          {computers.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No Mac is connected to this account yet. Add one to run your AI on it.</p>
          ) : (
            computers.map((d) => <DeviceRow key={d.id} device={d} workspace={d.owner === "workspace"} onChanged={reload} />)
          )}
        </Card>
      </Group>
      <Storage devices={own} storage={storage} onChanged={reload} />
      {devicesSectionsFor(me, webPlugins).map((s) => (
        <Group key={s.id} title={s.title}>
          {s.body}
        </Group>
      ))}
      {own.length >= 2 && balance && <LoadBalancing devices={own} balance={balance} onChanged={reload} />}
    </>
  );
}

function AddComputer() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground">
          <Plus className="h-3 w-3" />
          Add computer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a Mac</DialogTitle>
          <DialogDescription>The Creator Toolset Mac app runs your AI on a Mac you sign in on.</DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-foreground">
          <li>Install the Creator Toolset Mac app on the Mac.</li>
          <li>Sign in with this account.</li>
          <li>When it asks, allow it to run your AI there. It shows up under Computers within a minute.</li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

/** "Apple M2 Max · 12 cores · 32 GB, 8 GB free · 45 % busy · RTX 4080 SUPER, 3 of 16 GB free" */
function machineLine(m: Machine): string {
  const cpu = m.cpu?.replace(/\((R|TM)\)|\bProcessor\b|\b\d+-Core\b|\bCPU\b/g, "").replace(/\s+/g, " ").trim();
  return [
    cpu,
    `${m.cpus} cores`,
    `${Math.round(m.memGb)} GB${m.freeGb !== undefined ? `, ${Math.round(m.freeGb)} GB free` : ""}`,
    m.load !== undefined ? `${Math.round(m.load * 100)} % busy` : null,
    m.gpu ? `${m.gpu.replace(/^NVIDIA (GeForce )?/, "")}${m.gpuMemGb ? `, ${Math.round(m.gpuFreeGb ?? 0)} of ${Math.round(m.gpuMemGb)} GB free` : ""}` : null,
  ].filter(Boolean).join(" · ");
}

function DeviceRow({ device: d, workspace, onChanged }: { device: Device; workspace: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const Icon = d.report?.machine?.os === "mac" || !d.report?.machine ? Laptop : Monitor;
  const installed = d.report?.drivers.filter((x) => x.installed && runsOn(x.driver)) ?? [];

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await renameDevice(d.id, name.trim());
      setEditing(false);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setErr(null);
    try {
      await removeDevice(d.id);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    }
  };

  // The app answers only while "Use this Mac for my AI" is on, so an app that is open but off reads as offline.
  const status = d.online ? "Online · answering your AI" : d.lastSeen ? `Offline · last online ${fmtAgo(d.lastSeen)}` : "Offline";
  const tools = d.report
    ? installed.length
      ? `Runs your AI: ${installed.map((x) => `${TOOL_NAMES[x.driver] ?? x.driver}${x.version ? ` ${x.version}` : ""}`).join(", ")}`
      : "Runs your AI: no coding tool installed yet"
    : "Has not reported its coding tools yet.";

  return (
    <MachineRow
      icon={<Icon className="h-4 w-4" />}
      label={editing ? (
        <form onSubmit={rename} className="flex flex-wrap gap-2 py-0.5">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Computer name"
            className={`${selectCls} min-w-0 flex-1 py-1 text-sm`} />
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setName(d.name); }}>Cancel</Button>
        </form>
      ) : d.name}
      subtitle={
        <span className="flex min-w-0 items-center gap-1.5">
          <Dot on={d.online} />
          <span>{["Mac app", workspace ? "Workspace" : null, status, d.version ? `v${d.version}` : null].filter(Boolean).join(" · ")}</span>
        </span>
      }
      below={
        <>
          {d.report?.machine && <p className="mt-1 text-xs text-muted-foreground">{machineLine(d.report.machine)}</p>}
          <p className="mt-0.5 text-xs text-muted-foreground">{tools}{d.report ? ` · reported ${fmtAgo(d.report.at)}` : ""}</p>
          {d.kinds?.length ? <p className="mt-0.5 text-xs text-muted-foreground">Runs editor steps: {d.kinds.join(", ")}</p> : null}
          {!d.online && <p className="mt-0.5 text-xs text-muted-foreground">Not answering. Open the Mac app and turn on Use this Mac for my AI.</p>}
          {err && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
        </>
      }
    >
      {!editing && (
        <DropdownMenu onOpenChange={(o) => !o && setArmed(false)}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="size-7 text-muted-foreground" aria-label={`${d.name} actions`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}>Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={(e) => { if (!armed) { e.preventDefault(); setArmed(true); } else void remove(); }}>
              {armed ? "Click again to confirm" : "Remove"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </MachineRow>
  );
}

function MachineRow({ icon, label, subtitle, below, children }: { icon: ReactNode; label: ReactNode; subtitle: ReactNode; below?: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:px-4">
      <span aria-hidden className="text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
        {below}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Storage: the Library the app saves to, and the footage and music folders, each on one of this account's computers. */
async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
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
const getStorage = () => call<StorageView>(STORAGE_API);
const makeLibrary = (b: MakeLibraryBody) => call<StorageState>(`${STORAGE_API}/library`, "POST", b);
const addStorageFolder = (b: AddFolderBody) => call<StorageState>(`${STORAGE_API}/folders`, "POST", b);
const removeStorageFolder = (id: string) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}`, "DELETE");
const BALANCE_API = "/api/devices/balance";
const getBalance = () => call<Balance>(BALANCE_API);
const setBalanceSettings = (b: Partial<Balance>) => call<Balance>(BALANCE_API, "PUT", b);

const weightOf = (weights: Record<string, number>, id: string) =>
  LOAD_PREFERENCES.find((p) => p.value === (weights[id] ?? DEFAULT_WEIGHT))?.value ?? DEFAULT_WEIGHT;

/** The drives a computer reported (its system disk, external drives, network shares). Empty until it reports one. */
const disksOf = (d: Device): Disk[] => d.report?.machine?.disks ?? [];
const nameOf = (devices: Device[], host: string) => devices.find((d) => d.id === host)?.name ?? "A computer that is gone";

const size = (gb: number) => (gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`);
const full = (d: { freeGb: number; totalGb?: number }) => d.freeGb < 20 || (d.totalGb !== undefined && d.freeGb / d.totalGb < 0.1);
const space = (d: { freeGb: number; totalGb?: number }) => (
  <span className={cn(full(d) && "text-amber-600 dark:text-amber-400")}>
    {size(d.freeGb)} free{d.totalGb !== undefined ? ` of ${size(d.totalGb)}` : ""}{full(d) ? " · almost full" : ""}
  </span>
);

/** The disk a folder sits on: the longest drive path that holds it, else the system disk. A computer that reports no
 *  drives is read from the server's own disks (a local install: the computer is this machine). */
function diskOf(f: StorageFolder, devices: Device[], serverDisks: Disk[]): Disk | undefined {
  const host = devices.find((d) => d.id === f.origin.host);
  const disks = host && !disksOf(host).length ? serverDisks : host ? disksOf(host) : [];
  const holding = disks.filter((d) => d.path !== "/" && f.origin.path.startsWith(`${d.path.replace(/\/$/, "")}/`));
  return [...holding].sort((a, b) => b.path.length - a.path.length)[0] ?? disks.find((d) => d.path === "/");
}

/** A source's label: its folder name and computer; the Library's own Footage and Music read "Library/Footage". */
function sourceLabel(f: StorageFolder, folders: StorageFolder[], devices: Device[]): string {
  if (!folders.some((g) => g.id === f.id)) return `Library/${f.name}`;
  const base = f.origin.path.split("/").filter(Boolean).pop() ?? f.origin.path;
  return `${base} on ${nameOf(devices, f.origin.host)}`;
}

const roleLabel = (role: SourceRole) => STORAGE_ROLES.find((r) => r.value === role)?.label ?? role;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Storage({ devices, storage, onChanged }: { devices: Device[]; storage: StorageView | null; onChanged: () => void }) {
  if (!storage) return null;
  const folders = storage.folders;
  const sources = sourcesOf(folders);
  const drives = [
    ...devices.flatMap((d) => disksOf(d).map((disk) => ({ key: `${d.id}:${disk.path}`, disk, on: d.name }))),
    ...storage.serverDisks.map((disk) => ({ key: `server:${disk.path}`, disk, on: "this server" })),
  ];
  return (
    <Group title="Storage">
      <Card>
        <LibraryRow library={folders.find((f) => f.role === "library")} devices={devices} serverDisks={storage.serverDisks} onChanged={onChanged} />
        <SourceRow role="footage" sources={sources} folders={folders} devices={devices} onChanged={onChanged} />
        <SourceRow role="music" sources={sources} folders={folders} devices={devices} onChanged={onChanged} />
      </Card>
      <Drives drives={drives} />
    </Group>
  );
}

/** The Library: where the app saves. One setting, its location; Change applies from then on and moves nothing. */
function LibraryRow({ library, devices, serverDisks, onChanged }: { library?: StorageFolder; devices: Device[]; serverDisks: Disk[]; onChanged: () => void }) {
  const disk = library && diskOf(library, devices, serverDisks);
  return (
    <MachineRow icon={<Folder className="h-4 w-4" />} label="Save finished videos to"
      subtitle={library ? <>{nameOf(devices, library.origin.host)} · {library.origin.path}{disk && <> · {space(disk)}</>}</> : "Not set"}
      below={library?.error && <p className="mt-0.5 text-xs text-red-600 first-letter:uppercase dark:text-red-400">{library.error}</p>}
    >
      <MakeLibrary devices={devices} change={library !== undefined} onChanged={onChanged} />
    </MachineRow>
  );
}

function MakeLibrary({ devices, change, onChanged }: { devices: Device[]; change: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [pickHost, setPickHost] = useState("");
  const [folder, setFolder] = useState("~");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const host = devices.some((d) => d.id === pickHost) ? pickHost : devices[0]?.id ?? "";
  const where = `${folder.trim().replace(/\/+$/, "") || "~"}/${LIBRARY_NAME}`;

  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      await makeLibrary({ host, disk: folder.trim() });
      setOpen(false);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setErr(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">{change ? "Change" : "Create library"}</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Library</DialogTitle>
        </DialogHeader>
        {devices.length === 0 ? <Notice>No computer yet. Add one first.</Notice> : (
          <div className="grid gap-3">
            <Field label="Computer">
              <Select value={host} onValueChange={setPickHost}>
                <SelectTrigger size="sm" className="w-full" aria-label="Computer"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {devices.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Folder to put it in">
              <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~" aria-label="Folder to put it in"
                className={`${selectCls} min-w-0 py-1.5 text-sm`} />
            </Field>
            {where && <p className="font-mono text-xs text-muted-foreground">{where}</p>}
            {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void make()} disabled={busy || !folder.trim()}>{change ? "Change" : "Create"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Footage or music: its sources as one line, Add (a folder you have), and Remove for the listed ones. */
function SourceRow({ role, sources, folders, devices, onChanged }: {
  role: SourceRole; sources: StorageFolder[]; folders: StorageFolder[]; devices: Device[]; onChanged: () => void;
}) {
  const mine = sources.filter((f) => f.role === role);
  const listed = mine.filter((f) => folders.some((g) => g.id === f.id));
  return (
    <MachineRow icon={<Folder className="h-4 w-4" />} label={roleLabel(role)}
      subtitle={mine.length ? mine.map((f) => sourceLabel(f, folders, devices)).join(" · ") : "None"}
      below={listed.filter((f) => f.error).map((f) => (
        <p key={f.id} className="mt-0.5 text-xs text-red-600 first-letter:uppercase dark:text-red-400">{f.error}</p>
      ))}
    >
      <AddFolder role={role} devices={devices} onChanged={onChanged} />
      <SourceMenu sources={listed} onChanged={onChanged} />
    </MachineRow>
  );
}

/** Remove a listed source (its marker file stays where it is). Two clicks. */
function SourceMenu({ sources, onChanged }: { sources: StorageFolder[]; onChanged: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!sources.length) return null;
  const remove = async (id: string) => {
    setErr(null);
    try {
      await removeStorageFolder(id);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    }
  };
  return (
    <>
      <DropdownMenu onOpenChange={(o) => !o && setArmed(null)}>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" className="size-7 text-muted-foreground" aria-label="Remove a source">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sources.map((f) => (
            <DropdownMenuItem key={f.id} variant="destructive" onSelect={(e) => { if (armed !== f.id) { e.preventDefault(); setArmed(f.id); } else void remove(f.id); }}>
              {armed === f.id ? "Click again to remove" : `Remove ${f.name}`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
    </>
  );
}

/** "Add": use a folder you already have as footage or music, on one of this account's computers. */
function AddFolder({ role, devices, onChanged }: { role: SourceRole; devices: Device[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [pickHost, setPickHost] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const host = devices.some((d) => d.id === pickHost) ? pickHost : devices[0]?.id ?? "";

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await addStorageFolder({ role, host, path: path.trim() });
      setOpen(false);
      setPath("");
      onChanged();
    } catch (x) {
      setErr(msg(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setErr(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground">
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {roleLabel(role).toLowerCase()}</DialogTitle>
        </DialogHeader>
        {devices.length === 0 ? <Notice>No computer yet. Add one first.</Notice> : (
          <div className="grid gap-3">
            <Field label="Computer">
              <Select value={host} onValueChange={setPickHost}>
                <SelectTrigger size="sm" className="w-full" aria-label="Computer"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {devices.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Folder path">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Volumes/Drive/Footage" aria-label="Folder path"
                className={`${selectCls} min-w-0 py-1.5 text-sm`} />
            </Field>
            {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void add()} disabled={busy || !host || !path.trim()}>Add</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Load balancing: on/off, and each of this account's computers' preference. Shown only with two or more computers
 *  (lib/balance.ts). Off means a computer set to Off takes a job only when no other free computer can. */
function LoadBalancing({ devices, balance, onChanged }: { devices: Device[]; balance: Balance; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = (b: Partial<Balance>) => setBalanceSettings(b).then(onChanged, (e) => setErr(msg(e)));
  const summary = balance.on
    ? devices.flatMap((d) => {
        const w = weightOf(balance.weights, d.id);
        return w === DEFAULT_WEIGHT ? [] : [`${d.name} ${LOAD_PREFERENCES.find((p) => p.value === w)!.label.toLowerCase()}`];
      }).join(" · ")
    : "Off";

  return (
    <section className="mt-8">
      <Collapsible open={open} onOpenChange={setOpen}>
        <Card>
          <div className="flex items-center gap-4 px-3 sm:px-4">
            <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight aria-hidden className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
              <span className="shrink-0 text-sm font-medium">Load balancing</span>
              {summary && <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
            </CollapsibleTrigger>
            <Switch checked={balance.on} onCheckedChange={(on) => void save({ on })} aria-label="Automatically balance load" />
          </div>
          <CollapsibleContent className="[&>*+*]:border-t [&>*+*]:border-border/50">
            <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
              Start jobs on the computer with the most free CPU and memory.
            </p>
            {devices.map((d) => (
              <MachineRow key={d.id} icon={d.report?.machine?.os === "mac" || !d.report?.machine ? <Laptop className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
                label={d.name} subtitle={d.report?.machine?.cpu ?? "Mac app"}>
                <Select
                  value={String(weightOf(balance.weights, d.id))}
                  disabled={!balance.on}
                  onValueChange={(v) => void save({ weights: { [d.id]: Number(v) } })}
                >
                  <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label={`${d.name} load preference`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {LOAD_PREFERENCES.map((p) => (
                      <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </MachineRow>
            ))}
          </CollapsibleContent>
        </Card>
      </Collapsible>
      {err && <p className="mt-1 px-3 text-xs text-red-600 dark:text-red-400 sm:px-4">{err}</p>}
    </section>
  );
}

/** Drives: each computer's disks and free space; folded, amber when almost full. Empty until a computer reports a disk. */
function Drives({ drives }: { drives: { key: string; disk: Disk; on: string }[] }) {
  const [open, setOpen] = useState(false);
  if (!drives.length) return null;
  const almost = drives.filter((l) => full(l.disk)).length;
  return (
    <section className="mt-2">
      <Collapsible open={open} onOpenChange={setOpen}>
        <Card>
          <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
            <ChevronRight aria-hidden className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
            <span className="text-sm font-medium">Drives</span>
            {almost > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">{almost} almost full</span>}
          </CollapsibleTrigger>
          <CollapsibleContent className="[&>*+*]:border-t [&>*+*]:border-border/50">
            {drives.map(({ key, disk, on }) => (
              <MachineRow key={key} icon={<HardDrive className="h-4 w-4" />} label={disk.name}
                subtitle={<>{disk.network ? "Network" : disk.path === "/" ? "Built in" : "Drive"} · {on} · {space(disk)}</>} />
            ))}
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </section>
  );
}
