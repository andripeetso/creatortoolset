import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Copy, Laptop, Monitor, Plus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { allowOtherDevices, thisMacBridge } from "@/lib/thisMac";
import { getProviders, removeDevice, renameDevice, thisMacDevice } from "@/lib/providers";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, type Balance, type ProvidersView } from "@contracts/providers";
import { CONNECT_COMMAND, SHOW_CONNECT_COMMAND, mintPhoneCode, type PhoneState } from "@/components/setup/ConnectStep";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Advanced, Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, SettingsSelect, Status, saveFailed } from "./ui";
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
 * What the phone's code opens, as the one line a person needs: a plain-http address is this computer's network address
 * (the same Wi-Fi); an https one is a tunnel or the hosted site, so the line names the address.
 */
export function phoneLine(url: string): { wifi: boolean; host: string } {
  const u = new URL(url);
  return { wifi: u.protocol === "http:", host: u.host };
}

/**
 * Settings → Computers: the computers that run this account's AI, and the phones that use the app. One row per Mac (a Mac
 * that registered twice shows once), the `…` menu to rename or remove it, and in the Mac app this Mac's own switch. Admins
 * get load balancing under Advanced. `?add=1` opens the add-computer dialog, `?phone=1` the add-phone dialog (other pages
 * link there).
 */
export function ComputersSection() {
  const me = useAuth((s) => s.me);
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [phoning, setPhoning] = useState(false);
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
    <Section
      id="phones"
      title="Phones"
      action={
        <span data-settings-row="add-phone">
          <Button size="xs" variant="ghost" onClick={() => setPhoning(true)}>
            <Plus className="size-3" /> Add phone
          </Button>
        </span>
      }
    >
      <Card>
        <EmptyRow title="Use the app from your phone" description="Scan a code with its camera." />
      </Card>
    </Section>
  );

  if (error && !view) {
    return (
      <>
        <Section id="computers" title="Computers" action={addButton}>
          <Card>
            <ErrorRow title="Could not load your computers" detail={error} retry={load} />
          </Card>
        </Section>
        {phones}
        <AddPhoneDialog open={phoning} onOpenChange={setPhoning} />
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
        <AddPhoneDialog open={phoning} onOpenChange={setPhoning} />
      </>
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
      <Section id="computers" title="Computers" action={addButton}>
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

      {phones}

      <AddComputerDialog open={adding} onOpenChange={setAdding} macApp={inMac} />
      <AddPhoneDialog open={phoning} onOpenChange={setPhoning} />
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
                  body: mine ? "This Mac stops answering your AI. The AI set up on it is removed too." : "The AI set up on it is removed too.",
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

/**
 * Add computer: the Mac app is the way that works today. "Other ways" folds the command line (only once it is published,
 * SHOW_CONNECT_COMMAND) and "I already have a server" (the Mac app's Servers page; a browser cannot list servers).
 */
function AddComputerDialog({ open, onOpenChange, macApp }: { open: boolean; onOpenChange: (o: boolean) => void; macApp: boolean }) {
  const navigate = useNavigate();
  const otherWays = SHOW_CONNECT_COMMAND || macApp;
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
        {otherWays && (
          <Advanced summary="Other ways">
            {SHOW_CONNECT_COMMAND && (
              <Row
                className="px-0 sm:px-0"
                title="Command line"
                description="Run this on each computer you want to connect."
                children={
                  <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2 font-mono text-xs">
                    <span className="min-w-0 truncate">$ {CONNECT_COMMAND}</span>
                    <Button size="icon-xs" variant="ghost" aria-label="Copy the command" onClick={() => void navigator.clipboard?.writeText(CONNECT_COMMAND)}>
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                }
              />
            )}
            {macApp && (
              <Row
                className="px-0 sm:px-0"
                title="I already have a server"
                description="Its Creator Toolset runs on its own. Join it from Servers."
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onOpenChange(false);
                      navigate("/settings/servers?add=1");
                    }}
                  >
                    Open Servers
                  </Button>
                }
              />
            )}
          </Advanced>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A code is one-time and lasts a minute; the server keeps one live code per account (so this runs only while the dialog is open). */
const isCode = (c: PhoneState | undefined): c is Exclude<PhoneState, "local" | "signin" | null> => typeof c === "object" && c !== null;

/** After the Mac app restarts the server for "Access from other devices": asks again each second, 20 times at most. */
async function afterRestart(): Promise<PhoneState> {
  for (let tries = 1; ; tries++) {
    const c = await mintPhoneCode();
    if ((c !== null && c !== "local") || tries >= 20) return c;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/** The phone's code while the dialog is open: a new one when it runs out, a new one by the button, the Mac app's turn-on. */
function usePhoneCode(open: boolean) {
  const [code, setCode] = useState<PhoneState | undefined>(undefined); // undefined: making one
  const [now, setNow] = useState(() => Date.now());
  const [turningOn, setTurningOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(0);
  // a reply to an older request is dropped, so the screen shows the newest code only
  const fresh = useCallback((mint: () => Promise<PhoneState> = mintPhoneCode) => {
    const mine = ++latest.current;
    setCode(undefined);
    void mint().then((c) => {
      if (mine !== latest.current) return;
      setNow(Date.now());
      setCode(c);
    });
  }, []);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    fresh();
    return () => {
      latest.current++; // a reply that comes after the close is dropped
    };
  }, [open, fresh]);

  const live = isCode(code) && code.expiresAt !== Infinity;
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  const expired = isCode(code) && code.expiresAt <= now;
  useEffect(() => {
    if (expired) fresh();
  }, [expired, fresh]);

  const turnOn = async () => {
    setTurningOn(true);
    setProblem(null);
    const p = await allowOtherDevices();
    setTurningOn(false);
    if (p) setProblem(p);
    else fresh(afterRestart);
  };
  return {
    code,
    now,
    turningOn,
    problem,
    canTurnOn: !!thisMacBridge(),
    retry: () => fresh(),
    turnOn: () => void turnOn(),
  };
}

/** Add phone: the QR code the phone's camera reads, and the one line a person needs. Every state the code can be in is shown. */
function AddPhoneDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const p = usePhoneCode(open);
  const { code, now } = p;
  let body;
  if (code === undefined || (isCode(code) && code.expiresAt <= now)) {
    body = <Card><LoadingRow title="Making a code…" /></Card>;
  } else if (code === null) {
    body = <Card><ErrorRow title="Couldn't make a code" detail="Check the connection, then try again." retry={p.retry} /></Card>;
  } else if (code === "signin") {
    body = <Status tone="attention">Sign in first. The code appears here after that.</Status>;
  } else if (code === "local") {
    body = (
      <Card>
        <div className="space-y-2.5 px-3 py-3 sm:px-4">
          <p className="text-sm font-medium">Your phone can't reach this computer yet.</p>
          <p className="text-xs text-muted-foreground">
            {p.canTurnOn
              ? "Turn on Access from other devices. You choose this computer's password once."
              : "In the Creator Toolset Mac app, turn on Access from other devices, then come back here."}
          </p>
          {p.canTurnOn && (
            <Button type="button" size="sm" variant="outline" disabled={p.turningOn} onClick={p.turnOn}>
              Access from other devices
            </Button>
          )}
          {p.problem && <Status tone="broken">{p.problem}</Status>}
        </div>
      </Card>
    );
  } else {
    const { wifi, host } = phoneLine(code.url);
    body = (
      <div className="flex flex-col items-center gap-3 text-center">
        <img src={code.qr} alt="QR code: scan it with your phone's camera" className="size-52 rounded-lg bg-white p-2" />
        <p className="text-sm">{wifi ? "On the same Wi-Fi as this computer, scan it with the phone's camera." : `Scan it with the phone's camera. It opens ${host}.`}</p>
        {code.expiresAt !== Infinity && (
          <p className="text-xs text-muted-foreground">Scanning signs the phone's browser in as you. The code works once; when it runs out, a new one appears here.</p>
        )}
      </div>
    );
  }

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add your phone" submitLabel="New code" cancelLabel="Done" onSubmit={p.retry}>
      {body}
    </FormDialog>
  );
}
