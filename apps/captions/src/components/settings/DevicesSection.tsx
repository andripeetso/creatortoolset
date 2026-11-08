import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Laptop, Monitor, MoreHorizontal, Plus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { getProviders, removeDevice, renameDevice } from "@/lib/providers";
import type { Machine, ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Card, Dot, Group, Loading, Notice } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

type Device = ProvidersView["devices"][number];

/** Settings → Devices: one card of the computers that run this account's AI (and the workspace's, for admins), each with a … menu to rename or remove it. */
export function DevicesSection() {
  const me = useAuth((s) => s.me);
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    getProviders()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(msg(e)));

  useEffect(() => {
    void reload();
  }, []);

  if (error && !view) return <Notice tone="error">Could not load devices: {error}</Notice>;
  if (!view || !me) return <Loading />;

  const computers = view.devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));

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
    </>
  );
}

function AddComputer() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground">
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
  const installed = d.report?.drivers.filter((x) => x.installed) ?? [];

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

  const status = d.online ? "Online" : `Last seen ${fmtAgo(d.lastSeen)}`;
  const tools = d.report
    ? installed.length
      ? `Coding tools: ${installed.map((x) => `${x.driver}${x.version ? ` ${x.version}` : ""}`).join(", ")}`
      : "No coding tools found on it."
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
          <span className="truncate">{["Mac app", workspace ? "Workspace" : null, status, d.version ? `v${d.version}` : null].filter(Boolean).join(" · ")}</span>
        </span>
      }
      below={
        <>
          {d.report?.machine && <p className="mt-1 text-xs text-muted-foreground">{machineLine(d.report.machine)}</p>}
          <p className="mt-0.5 text-xs text-muted-foreground">{tools}{d.report ? ` · reported ${fmtAgo(d.report.at)}` : ""}</p>
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
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        {below}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}
