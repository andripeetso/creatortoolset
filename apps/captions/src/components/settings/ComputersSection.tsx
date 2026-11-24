import { SettingsDialog, SettingsDialogContent } from "./kit-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Laptop, Monitor, Plus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { removeDevice, renameDevice, thisMacDevice, useProviders } from "@/lib/providers";
import { devicesSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { ConnectionsCard } from "./ConnectionsCard";
import { PhonesSection } from "./SignedInClients";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, markSave, Row, RowMenu, Section, Status } from "./ui";
import { CopyBox } from "./copy-box";
import { fmtAgo } from "./helpers";
import { groupComputers, kindOf, type ComputerGroup, type Listed, type ThisMacNames } from "./computers-group";
import { hasThisMac, SharedDrivesRow, tell, useThisMac, type ThisMacState } from "./ThisMacSection";
import { HelperSetup, readyLine } from "@/components/setup/HelperStep";
import { useCachedLoad } from "@/lib/local-cache";
import { AllowedFolders, call } from "./StorageRows";
import { unreachedShares, type StorageView } from "@contracts/storage";
import type { Balance, Device, DeviceWaits } from "@contracts/providers";
import { listLibraries } from "@/lib/library";
import type { LibrarySummary } from "@contracts/library";

const STORAGE_ALL = "/api/devices/storage?all=1";
const DEVICES = "/api/devices";
import { LoadBalancing } from "./ServerWorkSection";

/** The Mac's hardware, as the subtitle's tail for an admin: "Apple M2 Max · 12 cores · 32 GB". */
const hardware = (d: Listed): string | null => {
  const m = d.report?.machine;
  if (!m) return null;
  return [m.cpu?.replace(/\((R|TM)\)|\bProcessor\b/g, "").replace(/\s+/g, " ").trim(), `${m.cpus} cores`, `${Math.round(m.memGb)} GB`].filter(Boolean).join(" · ");
};

/**
 * Settings → Computers: the computers that run this account's AI, and the phones that use the app. One row per Mac (a Mac
 * that registered twice is listed once), the `…` menu to rename or remove it, and in the Mac app this Mac's own switch. The
 * plug-ins' "computers" cards sit under the list, without a heading (the AI Editor's folded Load balancing). The ones
 * offline a day or more with no AI on them are a section of their own, open. Under them this computer's connections and
 * the Phones section (pairing links and signed-in devices). `?add=1` opens the add-computer dialog, `?phone=1` Create link
 * (other pages link there).
 */
export function ComputersSection() {
  const me = useAuth((s) => s.me);
  const cloud = useAuth((s) => s.kind === "cloud");
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [phoning, setPhoning] = useState(false);
  const { data: view, error, refresh } = useProviders();
  const inMac = hasThisMac();
  const bridge = useThisMac(inMac);

  const load = useCallback(() => void refresh().catch(() => {}), [refresh]);

  // `?add=1` and `?phone=1` open their dialog once, then the parameters go
  useEffect(() => {
    const add = params.get("add") === "1";
    const phone = params.get("phone") === "1";
    if (!add && !phone) return;
    if (add) setAdding(true);
    if (phone) setPhoning(true);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("add");
      next.delete("phone");
      return next;
    }, { replace: true });
  }, [params, setParams]);

  const addButton = (
    <span data-settings-row="add-computer">
      <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
        <Plus className="size-3" /> Add computer
      </Button>
    </span>
  );
  const phones = (
    <>
      {!cloud && <ConnectionsCard inMac={inMac} mac={bridge} />}
      <PhonesSection create={phoning} onCreateChange={setPhoning} />
    </>
  );

  if (error && !view) {
    return (
      <>
        <Section id="computers" title="Computers" action={addButton}>
          <Card>
            <ErrorRow title="Could not load computers" detail={error} retry={load} />
          </Card>
        </Section>
        {phones}
      </>
    );
  }
  if (!view || !me) {
    return (
      <>
        <Section id="computers" title="Computers" action={addButton}>
          <Card>
            <LoadingRow />
          </Card>
        </Section>
        {phones}
      </>
    );
  }

  const computers = view.devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));
  // this Mac's names come from the Mac app's bridge; an older app sends none, so nothing merges by name then
  const names: ThisMacNames = inMac ? { computer: bridge?.computer, host: bridge?.host, device: bridge?.device || thisMacDevice() } : {};
  const withAi = new Set([...(view.own?.instances ?? []), ...(view.workspace?.settings.instances ?? [])].map((i) => i.device));
  const groups = groupComputers(computers, me.username, names, (id) => withAi.has(id));
  const listed = groups.filter((g) => !g.old);
  const old = groups.filter((g) => g.old);
  // the Mac app's Mac when it is not on the list yet: its switch adds it
  const unlisted = inMac && !groups.some((g) => g.mine);

  return (
    <>
      <Section id="computers" title="Computers" action={addButton}>
        <Card>
          {listed.length === 0 && !unlisted && <EmptyRow title="No computers" />}
          {listed.map((g) => (
            <ComputerRow key={g.primary.id} group={g} admin={me.role === "admin"} bridge={g.mine ? bridge : null} onChanged={load} />
          ))}
          {unlisted && <ThisMacSwitch bridge={bridge} />}
        </Card>
        <div className="pt-5 empty:hidden">
          <LoadBalancing computers={computers.filter((d) => d.owner === me.username)} />
        </div>
        {/* the plug-ins' cards sit under the list, with no heading of their own (the AI Editor's Load balancing) */}
        {devicesSectionsFor(me, webPlugins, "computers").map((s) => (
          <div key={s.id} className="pt-5 empty:hidden">{s.body}</div>
        ))}
      </Section>

      {/* what this Mac may read: one computer's own list, so it sits with the computers, not in the sidebar */}
      {inMac && <AllowedFolders />}

      {phones}

      {old.length > 0 && (
        <Section title="Offline computers">
          <Card>
            {old.map((g) => (
              <OfflineRow key={g.primary.id} group={g} onChanged={load} />
            ))}
          </Card>
        </Section>
      )}

      <AddComputerDialog open={adding} onOpenChange={setAdding} macApp={inMac} computers={computers} />
    </>
  );
}

function ComputerRow({ group, admin, bridge, onChanged }: {
  group: ComputerGroup; admin: boolean; bridge: ThisMacState | null; onChanged: () => void;
}) {
  const { primary, records, mine } = group;
  const Icon = primary.report?.machine?.os === "mac" || !primary.report?.machine ? Laptop : Monitor;
  const online = records.some((r) => r.online);
  const lastSeen = Math.max(0, ...records.map((r) => r.lastSeen ?? 0));
  const worker = records.find((r) => r.owner === "workspace");
  // this Mac with its AI switched off is not offline: that is its choice
  const offline = !online && (!mine || !!bridge?.aiOn);
  const hw = admin ? hardware(primary) : null;
  // what it is, then its state, then the hardware (shown from `sm` up): name → what it is → state
  const kind = mine ? (worker ? kindOf(worker) : null) : kindOf(primary);
  const [setUp, setSetUp] = useState(false);
  // its last test for helping with heavy work: a folder it could not read or a failed encode needs fixing; fine is quiet
  const check = primary.check;
  const failedRead = check?.folders.find((f) => !f.ok);
  // a computer that takes work and lacks a share one of the account's folders is on: Set up shows how to connect it,
  // and the line goes by itself once its next report has the share
  const { data: storage } = useCachedLoad<StorageView>(STORAGE_ALL, () => call<StorageView>(STORAGE_ALL), { topic: "devices", own: true });
  const unreached = primary.work && storage ? unreachedShares(storage.folders, primary.id) : [];
  // the library work it holds up (api/work/waits.ts): work it has not taken (red), or that it must be added again
  const { data: listed } = useCachedLoad<(Device & { waits?: DeviceWaits })[]>(DEVICES, () => call(DEVICES), { topic: ["devices", "library"], own: true });
  const held = records.map((r) => listed?.find((d) => d.id === r.id)?.waits).filter((w): w is DeviceWaits => !!w);
  const waits = held.find((w) => w.tone === "stuck") ?? held[0];
  const state = waits ? (
    <Status tone={waits.tone === "stuck" ? "broken" : "attention"}>{waits.line}</Status>
  ) : offline ? (
    <Status tone="attention">{`Offline${lastSeen ? ` · last seen ${fmtAgo(lastSeen)}` : ""}`}</Status>
  ) : check && !readyLine(primary, check) ? (
    <Status tone="attention">{failedRead ? `Can't read ${failedRead.name}` : "Test failed"}</Status>
  ) : unreached.length ? (
    <button type="button" className="underline-offset-2 hover:underline" onClick={() => setSetUp(true)}>
      <Status tone="attention">{`Doesn't reach ${unreached.join(", ")}`}</Status>
    </button>
  ) : null;
  const subtitle = (
    <>
      {[mine ? "This Mac" : null, kind, state, hw ? <span className="hidden sm:inline">{hw}</span> : null].filter(Boolean).map((part, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {part}
        </span>
      ))}
    </>
  );
  // this Mac is titled with its own name and says "This Mac" first in its line (a long title would cut off)
  const title = (mine && bridge?.computer) || primary.name;

  const rename = async () => {
    const name = (await promptDialog({ title: "Rename computer", value: primary.name, ok: "Rename" }))?.trim();
    if (!name || name === primary.name) return;
    await Promise.all(records.map((r) => renameDevice(r.id, name)));
    onChanged();
  };
  const remove = async () => {
    // this Mac's own record goes through the app (it stops and removes itself); the others are removed here
    const self = mine ? thisMacDevice() : undefined;
    if (mine) tell("forget");
    for (const r of records) if (r.id !== self) await removeDevice(r.id);
    setTimeout(onChanged, mine ? 1200 : 0);
  };

  return (
    <>
      <ListRow
        icon={<Icon className="size-4" />}
        title={title}
        subtitle={subtitle}
        actions={
          <RowMenu
            label={`${primary.name} actions`}
            items={[
              { label: "Set up", onSelect: () => setSetUp(true) },
              { label: "Rename", onSelect: rename },
              {
                label: "Remove",
                destructive: true,
                confirm: {
                  title: `Remove ${primary.name}?`,
                  body: "The AI providers on it are removed too.",
                  ok: "Remove",
                },
                onSelect: remove,
              },
            ]}
          />
        }
      />
      {mine && <ThisMacSwitch bridge={bridge} />}
      {setUp && <HelperDialog device={primary.id} name={primary.name} onClose={() => setSetUp(false)} />}
    </>
  );
}

/**
 * This Mac's own switches: Take work from this server adds this Mac to the account, and then it takes this server's jobs; Shared
 * drives. Under this Mac's row once it is on the list; before that they are its only rows (a row that could only name
 * this Mac has no action).
 */
function ThisMacSwitch({ bridge }: { bridge: ThisMacState | null }) {
  return (
    <>
      <Row
        id="use-this-mac"
        title="Take work from this server"
        description="This Mac runs this server's jobs for your account while Creator Toolset is open: AI requests, editor steps and media library work."
        status={bridge?.lastError ? <Status tone="broken">{bridge.lastError}</Status> : undefined}
        control={
          <Switch checked={!!bridge?.aiOn} disabled={!bridge} aria-label="Take work from this server" onCheckedChange={(on) => void markSave(tell(on ? "ai:on" : "ai:off"))} />
        }
      />
      <SharedDrivesRow bridge={bridge} />
    </>
  );
}

/** A computer of this account that has been offline a day or more and has no AI on it: when it was last seen; Remove in its menu. */
function OfflineRow({ group, onChanged }: { group: ComputerGroup; onChanged: () => void }) {
  const { primary, records } = group;
  const lastSeen = Math.max(0, ...records.map((r) => r.lastSeen ?? 0));
  const remove = async () => {
    for (const r of records) await removeDevice(r.id);
    onChanged();
  };
  return (
    <ListRow
      icon={<Laptop className="size-4" />}
      title={primary.name}
      subtitle={lastSeen ? `Last seen ${fmtAgo(lastSeen)}` : undefined}
      actions={
        <RowMenu
          label={`${primary.name} actions`}
          items={[
            {
              label: "Remove",
              destructive: true,
              confirm: { title: `Remove ${primary.name}?`, ok: "Remove" },
              onSelect: remove,
            },
          ]}
        />
      }
    />
  );
}

/**
 * Add computer: the Mac app is the way that works today. In the Mac app, the Existing server row opens Add server on
 * its Servers page (a browser cannot list servers). The close X takes no focus on open.
 */
/** The one command a Linux computer runs: the server hands out the helper (public/helper) and the computer swaps the code for its token. */
export const linuxCommand = (url: string, code: string) => `curl -fsSL ${url}/helper/install.sh | sh -s -- ${url} ${code}`;

/** A computer's Help screen (setup/HelperStep.tsx) in a dialog: its row's Set up. */
function HelperDialog({ device, name, onClose }: { device: string; name: string; onClose: () => void }) {
  return (
    <SettingsDialog open onOpenChange={(o) => !o && onClose()}>
      <SettingsDialogContent className="sm:max-w-xl" aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Set up {name}</DialogTitle>
        </DialogHeader>
        <HelperSetup device={device} />
        <LibraryWork device={device} />
      </SettingsDialogContent>
    </SettingsDialog>
  );
}

/**
 * Which Media Library work a computer takes (Settings → Computers, Set up): every library unless narrowed to some, and
 * whether it may download an original to make a proxy (until set: no on Linux or Windows, else yes). Only for a computer
 * whose worker takes library work.
 */
function LibraryWork({ device }: { device: string }) {
  const { data: view } = useProviders();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void call<Balance>("/api/devices/balance").then(setBalance, (e: Error) => setProblem(e.message));
    void listLibraries().then((l) => setLibraries(l.filter((x) => !x.readOnly)), () => {});
  }, []);
  const d = view?.devices.find((x) => x.id === device);
  if (!d?.work?.library || !balance) return null;
  const only = balance.libraries?.[device];
  const originals = balance.originals?.[device] ?? !["linux", "windows"].includes(d.report?.machine?.os ?? "");
  const save = (body: Partial<Record<"libraries" | "originals", unknown>>) =>
    markSave(call<Balance>("/api/devices/balance", "PUT", body)).then(setBalance, (e: Error) => setProblem(e.message));
  const pick = (id: string, on: boolean) => {
    const next = new Set(only ?? libraries.map((l) => l.id));
    if (on) next.add(id);
    else next.delete(id);
    void save({ libraries: { [device]: [...next] } });
  };
  return (
    <Card>
      <Row
        title="All libraries"
        description="Media Library work: proxies, waveforms, frame strips, fingerprints and transcripts"
        status={problem ? <Status tone="broken">{problem}</Status> : undefined}
        control={<Switch checked={!only} aria-label="Media Library work for all libraries" onCheckedChange={(v) => void save({ libraries: { [device]: v ? null : libraries.map((l) => l.id) } })} />}
      />
      {only &&
        libraries.map((l) => (
          <Row key={l.id} title={l.name} control={<Switch checked={only.includes(l.id)} aria-label={`Media Library work for ${l.name}`} onCheckedChange={(v) => pick(l.id, v)} />} />
        ))}
      <Row
        title="Download originals"
        description="Makes the proxy of a phone or browser upload from its original"
        control={<Switch checked={originals} aria-label="Download originals" onCheckedChange={(v) => void save({ originals: { [device]: v } })} />}
      />
    </Card>
  );
}

function AddComputerDialog({ open, onOpenChange, macApp, computers }: { open: boolean; onOpenChange: (o: boolean) => void; macApp: boolean; computers: Listed[] }) {
  const navigate = useNavigate();
  // the computers there when it opened: one added after is the new one, and its Help screen follows here
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    known.current = open ? new Set(computers.map((c) => c.id)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the list at the moment it opens
  }, [open]);
  const fresh = open && known.current ? computers.find((c) => !known.current!.has(c.id)) : undefined;
  if (fresh) {
    return (
      <SettingsDialog open={open} onOpenChange={onOpenChange}>
        <SettingsDialogContent className="sm:max-w-xl" aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Set up {fresh.name}</DialogTitle>
          </DialogHeader>
          <HelperSetup device={fresh.id} />
        </SettingsDialogContent>
      </SettingsDialog>
    );
  }
  return (
    <SettingsDialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="sm:max-w-md" aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Add computer</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="mac">
          <TabsList>
            <TabsTrigger value="mac">Mac</TabsTrigger>
            <TabsTrigger value="linux">Linux</TabsTrigger>
          </TabsList>
          <TabsContent value="mac" className="space-y-3 pt-2">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
              <li>Install the Creator Toolset Mac app on the Mac.</li>
              <li>Open it and sign in with this account.</li>
              <li>Turn on “Take work from this server” on this Mac.</li>
            </ol>
            {macApp && (
              <Card>
                <Row
                  title="Existing server"
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        onOpenChange(false);
                        navigate("/settings/servers?add=1");
                      }}
                    >
                      Add server
                    </Button>
                  }
                />
              </Card>
            )}
          </TabsContent>
          <TabsContent value="linux" className="pt-2">
            <LinuxSteps />
          </TabsContent>
        </Tabs>
        <p className="text-xs text-muted-foreground">Setup continues here once the computer is added.</p>
      </SettingsDialogContent>
    </SettingsDialog>
  );
}

type LinuxCode = { code: string; url: string | null; expiresAt: number };

/**
 * A Linux computer (with or without a graphics card) runs speech models for this account: a one-time code (10 minutes,
 * works once) inside the one command to run there. Made when the tab opens, and again when it runs out.
 */
function LinuxSteps() {
  const [code, setCode] = useState<LinuxCode | null | undefined>(undefined); // undefined: making one; null: couldn't
  const mint = useCallback(() => {
    setCode(undefined);
    void fetch("/api/devices/code", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<LinuxCode>) : null))
      .catch(() => null)
      .then(setCode);
  }, []);
  useEffect(mint, [mint]);
  useEffect(() => {
    if (!code) return;
    const t = window.setTimeout(mint, Math.max(0, code.expiresAt - Date.now()));
    return () => window.clearTimeout(t);
  }, [code, mint]);

  if (code === undefined) return <Card><LoadingRow title="Creating a code…" /></Card>;
  if (code === null) return <Card><ErrorRow title="Could not create a code" detail="Check the connection, then try again." retry={mint} /></Card>;
  // "Network access" is the switch's name in the Mac app
  if (!code.url) return <Status tone="attention">Needs Network access, in the Creator Toolset Mac app</Status>;
  return (
    <div className="space-y-3 text-sm">
      <p>Run this on the Linux computer, as the user it should run under.</p>
      <CopyBox text={linuxCommand(code.url, code.code)} />
      <p className="text-xs text-muted-foreground">The code {code.code} works once, for 10 minutes.</p>
    </div>
  );
}
