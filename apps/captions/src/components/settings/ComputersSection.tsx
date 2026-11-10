import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Laptop, Monitor, Plus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { getProviders, removeDevice, renameDevice, thisMacDevice } from "@/lib/providers";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, type Balance, type ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Advanced, Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { fmtAgo, msg } from "./helpers";
import { groupComputers, type ComputerGroup, type Listed } from "./computers-group";
import { call } from "./StorageRows";
import { hasThisMac, tell, useThisMac, type ThisMacState } from "./ThisMacSection";

const BALANCE_API = "/api/devices/balance";
const getBalance = () => call<Balance>(BALANCE_API);
const setBalanceSettings = (b: Partial<Balance>) => call<Balance>(BALANCE_API, "PUT", b);
const weightOf = (weights: Record<string, number>, id: string) =>
  LOAD_PREFERENCES.find((p) => p.value === (weights[id] ?? DEFAULT_WEIGHT))?.value ?? DEFAULT_WEIGHT;

/** The Mac's hardware, as the subtitle's tail for an admin: "Apple M2 Max · 12 cores · 32 GB". */
const hardware = (d: Listed): string | null => {
  const m = d.report?.machine;
  if (!m) return null;
  return [m.cpu?.replace(/\((R|TM)\)|\bProcessor\b/g, "").replace(/\s+/g, " ").trim(), `${m.cpus} cores`, `${Math.round(m.memGb)} GB`].filter(Boolean).join(" · ");
};

/**
 * Settings → Computers: the computers that run this account's AI. One row per Mac (a Mac that registered twice shows
 * once), the `…` menu to rename or remove it, and in the Mac app this Mac's own switch. Admins get load balancing under
 * Advanced. `?add=1` opens the add dialog (other pages link there).
 */
export function ComputersSection() {
  const me = useAuth((s) => s.me);
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get("add") === "1");
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inMac = hasThisMac();
  const bridge = useThisMac(inMac);

  const load = useCallback(() => {
    getProviders()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(msg(e)));
  }, []);
  useEffect(() => load(), [load]);

  // `?add=1` opens the dialog once, then the parameter goes
  useEffect(() => {
    if (params.get("add") !== "1") return;
    setAdding(true);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("add");
      return next;
    }, { replace: true });
  }, [params, setParams]);

  const addButton = (
    <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
      <Plus className="size-3" /> Add computer
    </Button>
  );

  if (error && !view) {
    return (
      <Section title="Computers" action={addButton}>
        <Card>
          <ErrorRow title="Could not load your computers" detail={error} retry={load} />
        </Card>
      </Section>
    );
  }
  if (!view || !me) {
    return (
      <Section title="Computers" action={addButton}>
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );
  }

  const computers = view.devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));
  const own = view.devices.filter((d) => d.owner === me.username);
  const groups = groupComputers(computers, me.username);
  const thisMac = inMac ? thisMacDevice() : undefined;
  const thisGroup = groups.find((g) => g.records.some((r) => r.id === thisMac));
  // the Mac app's Mac, when it is not on the list yet (not paired): its switch still pairs it
  const unlisted = inMac && !thisGroup;

  return (
    <>
      <Section title="Computers" action={addButton}>
        <Card>
          {groups.length === 0 && !unlisted && (
            <EmptyRow title="No computers yet" description="Your AI runs on a Mac you sign in on, with the Creator Toolset Mac app." />
          )}
          {groups.map((g) => (
            <ComputerRow
              key={g.primary.id}
              group={g}
              admin={me.role === "admin"}
              mine={g === thisGroup}
              bridge={g === thisGroup ? bridge : null}
              onChanged={load}
            />
          ))}
          {unlisted && <ThisMacRow bridge={bridge} />}
        </Card>
      </Section>

      {me.role === "admin" && own.length >= 2 && (
        <Card>
          <LoadBalancing devices={own} />
        </Card>
      )}

      <AddComputerDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function ComputerRow({ group, admin, mine, bridge, onChanged }: {
  group: ComputerGroup; admin: boolean; mine: boolean; bridge: ThisMacState | null; onChanged: () => void;
}) {
  const { primary, records } = group;
  const Icon = primary.report?.machine?.os === "mac" || !primary.report?.machine ? Laptop : Monitor;
  const team = primary.owner === "workspace";
  const online = records.some((r) => r.online);
  const lastSeen = Math.max(0, ...records.map((r) => r.lastSeen ?? 0));
  // this Mac with its AI switched off is not offline: that is its choice
  const offline = !online && (!mine || !!bridge?.aiOn);
  const hw = admin ? hardware(primary) : null;
  const subtitle = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{["Mac app", team ? "Team" : null].filter(Boolean).join(" · ")}</span>
      {offline && <Status tone="attention">Offline{lastSeen ? ` · last seen ${fmtAgo(lastSeen)}` : ""}</Status>}
      {hw && <span className="min-w-0 truncate">· {hw}</span>}
    </span>
  );

  const rename = async () => {
    const name = (await promptDialog({ title: "Rename computer", value: primary.name, ok: "Rename" }))?.trim();
    if (!name || name === primary.name) return;
    await Promise.all(records.map((r) => renameDevice(r.id, name)));
    onChanged();
  };
  const remove = async () => {
    // this Mac's own record goes through the app (it stops answering and removes itself); the others are removed here
    const self = mine ? thisMacDevice() : undefined;
    if (mine) tell("forget");
    for (const r of records) if (r.id !== self) await removeDevice(r.id);
    setTimeout(onChanged, mine ? 1200 : 0);
  };

  return (
    <ListRow
      id={mine ? "use-this-mac" : undefined}
      icon={<Icon className="size-4" />}
      title={primary.name}
      subtitle={subtitle}
      status={mine && bridge?.lastError ? <Status tone="broken">{bridge.lastError}</Status> : undefined}
      actions={
        <>
          {mine && (
            <Switch
              checked={!!bridge?.aiOn}
              disabled={!bridge}
              aria-label="Use this Mac for my AI"
              onCheckedChange={(on) => tell(on ? "ai:on" : "ai:off")}
            />
          )}
          <RowMenu
            label={`${primary.name} actions`}
            items={[
              { label: "Rename", onSelect: rename },
              {
                label: "Remove",
                destructive: true,
                confirm: {
                  title: `Remove ${primary.name}?`,
                  body: mine ? "This Mac stops answering your AI, and its AI providers go with it." : "Its AI providers go with it.",
                  ok: "Remove",
                },
                onSelect: remove,
              },
            ]}
          />
        </>
      }
    />
  );
}

/** This Mac before it is on the list (not paired yet): only its switch. */
function ThisMacRow({ bridge }: { bridge: ThisMacState | null }) {
  return (
    <ListRow
      id="use-this-mac"
      icon={<Laptop className="size-4" />}
      title="This Mac"
      subtitle="Mac app"
      actions={
        <Switch checked={!!bridge?.aiOn} disabled={!bridge} aria-label="Use this Mac for my AI" onCheckedChange={(on) => tell(on ? "ai:on" : "ai:off")} />
      }
    />
  );
}

/** Admins with two or more computers: how jobs are spread between them. Its own errors show here. */
function LoadBalancing({ devices }: { devices: Listed[] }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    getBalance().then(setBalance).catch((e) => setError(msg(e)));
  }, []);
  useEffect(() => load(), [load]);
  const save = (b: Partial<Balance>) => setBalanceSettings(b).then(setBalance).catch((e) => saveFailed(msg(e)));

  return (
    <Advanced summary="Advanced">
      {error && <ErrorRow title="Could not load load balancing" detail={error} retry={load} />}
      {!balance && !error && <LoadingRow />}
      {balance && (
        <>
          <Row
            id="load-balancing"
            title="Load balancing"
            description="Start jobs on the computer with the most free CPU and memory."
            control={<Switch checked={balance.on} aria-label="Load balancing" onCheckedChange={(on) => void save({ on })} />}
          />
          {devices.map((d) => (
            <ListRow
              key={d.id}
              icon={d.report?.machine?.os === "mac" || !d.report?.machine ? <Laptop className="size-4" /> : <Monitor className="size-4" />}
              title={d.name}
              subtitle={d.report?.machine?.cpu ?? "Mac app"}
              actions={
                <SettingsSelect
                  label={`${d.name} load preference`}
                  value={String(weightOf(balance.weights, d.id))}
                  disabled={!balance.on}
                  onValueChange={(v) => void save({ weights: { [d.id]: Number(v) } })}
                  options={LOAD_PREFERENCES.map((p) => ({ value: String(p.value), label: p.label }))}
                  className="sm:w-32"
                />
              }
            />
          ))}
        </>
      )}
    </Advanced>
  );
}

/** Add computer: one dialog. The Mac app is the only way that works today (the command-line connect does not add a computer here). */
function AddComputerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Add a computer</DialogTitle>
        </DialogHeader>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
          <li>Install the Creator Toolset Mac app on the Mac.</li>
          <li>Sign in there with this account.</li>
          <li>Turn on Use this Mac for my AI. It shows up here.</li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
