import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Laptop, Monitor, Plus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { allowOtherDevices, thisMacBridge } from "@/lib/thisMac";
import { getProviders, removeDevice, renameDevice, thisMacDevice } from "@/lib/providers";
import { devicesSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import type { ProvidersView } from "@contracts/providers";
import { mintPhoneCode, type PhoneState } from "@/components/setup/ConnectStep";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Advanced, Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section, Status } from "./ui";
import { fmtAgo, msg } from "./helpers";
import { groupComputers, kindOf, type ComputerGroup, type Listed, type ThisMacNames } from "./computers-group";
import { hasThisMac, tell, useThisMac, type ThisMacState } from "./ThisMacSection";

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
 * that registered twice shows once), the `…` menu to rename or remove it, and in the Mac app this Mac's own switch. The
 * plug-ins' "computers" sections come after the list (the AI Editor's computers and their share of its jobs). `?add=1`
 * opens the add-computer dialog, `?phone=1` the add-phone dialog (other pages link there).
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
    <Section id="phones" title="Phones">
      <Card>
        <Row
          id="add-phone"
          title="Phone"
          description="Scan a code with the Creator Toolset iPhone app, or with the phone's camera."
          control={
            <Button size="sm" variant="outline" onClick={() => setPhoning(true)}>
              Add phone
            </Button>
          }
        />
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
  // this Mac's names come from the Mac app's bridge; an older app sends none, so nothing merges by name then
  const names: ThisMacNames = inMac ? { computer: bridge?.computer, host: bridge?.host, device: bridge?.device || thisMacDevice() } : {};
  const withAi = new Set([...(view.own?.instances ?? []), ...(view.workspace?.settings.instances ?? [])].map((i) => i.device));
  const groups = groupComputers(computers, me.username, names, (id) => withAi.has(id));
  const listed = groups.filter((g) => !g.old);
  const old = groups.filter((g) => g.old);
  // the Mac app's Mac when it is not on the list (not paired yet): its switch still pairs it
  const unlisted = inMac && !groups.some((g) => g.mine);

  return (
    <>
      <Section id="computers" title="Computers" action={addButton}>
        <Card>
          {listed.length === 0 && !unlisted && (
            <EmptyRow title="No computers yet" description="Your AI runs on a Mac you sign in on, with the Creator Toolset Mac app." />
          )}
          {listed.map((g) => (
            <ComputerRow key={g.primary.id} group={g} admin={me.role === "admin"} bridge={g.mine ? bridge : null} onChanged={load} />
          ))}
          {unlisted && <ThisMacRow names={names} bridge={bridge} />}
        </Card>
      </Section>

      {devicesSectionsFor(me, webPlugins, "computers").map((s) => (
        <Section key={s.id} title={s.title}>
          {s.body}
        </Section>
      ))}

      {phones}

      {old.length > 0 && (
        <Card>
          <Advanced summary={`Old pairings (${old.length})`}>
            {old.map((g) => (
              <OldPairingRow key={g.primary.id} group={g} onChanged={load} />
            ))}
          </Advanced>
        </Card>
      )}

      <AddComputerDialog open={adding} onOpenChange={setAdding} macApp={inMac} />
      <AddPhoneDialog open={phoning} onOpenChange={setPhoning} />
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
  const state = offline ? (
    <Status tone="attention">{`Offline${lastSeen ? ` · last seen ${fmtAgo(lastSeen)}` : ""}`}</Status>
  ) : mine && worker ? (
    "running"
  ) : null;
  const subtitle = (
    <>
      {[mine ? "This Mac" : null, kind, state].filter(Boolean).map((part, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {part}
        </span>
      ))}
      {hw && <span className="hidden sm:inline"> · {hw}</span>}
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
    // this Mac's own record goes through the app (it stops answering and removes itself); the others are removed here
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
        }
      />
      {mine && <ThisMacSwitch bridge={bridge} />}
    </>
  );
}

/** This Mac's own switch: it pairs this Mac with the account, and then the app's AI jobs run on it. */
function ThisMacSwitch({ bridge }: { bridge: ThisMacState | null }) {
  return (
    <Row
      id="use-this-mac"
      title="Use this Mac for my AI"
      description="Pairs this Mac with your account, so the AI jobs your AI runs can run on it."
      status={bridge?.lastError ? <Status tone="broken">{bridge.lastError}</Status> : undefined}
      control={
        <Switch checked={!!bridge?.aiOn} disabled={!bridge} aria-label="Use this Mac for my AI" onCheckedChange={(on) => tell(on ? "ai:on" : "ai:off")} />
      }
    />
  );
}

/** This Mac before it is on the list (not paired yet): its name and its switch. */
function ThisMacRow({ names, bridge }: { names: ThisMacNames; bridge: ThisMacState | null }) {
  return (
    <>
      <ListRow icon={<Laptop className="size-4" />} title={names.computer || "This Mac"} subtitle="This Mac" />
      <ThisMacSwitch bridge={bridge} />
    </>
  );
}

/** An old pairing (offline a day or more, no AI on it): what it is and when it was last seen; Remove in its menu. */
function OldPairingRow({ group, onChanged }: { group: ComputerGroup; onChanged: () => void }) {
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
      subtitle={`Mac app · Offline${lastSeen ? ` · last seen ${fmtAgo(lastSeen)}` : ""}`}
      actions={
        <RowMenu
          label={`${primary.name} actions`}
          items={[
            {
              label: "Remove",
              destructive: true,
              confirm: { title: `Remove ${primary.name}?`, body: "The Mac can pair again later.", ok: "Remove" },
              onSelect: remove,
            },
          ]}
        />
      }
    />
  );
}

/**
 * Add computer: the Mac app is the way that works today. In the Mac app, "Other ways" folds "I already have a server" (its
 * Servers page; a browser cannot list servers). The close X takes no focus on open.
 */
function AddComputerDialog({ open, onOpenChange, macApp }: { open: boolean; onOpenChange: (o: boolean) => void; macApp: boolean }) {
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Add a computer</DialogTitle>
        </DialogHeader>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
          <li>Install the Creator Toolset Mac app on the Mac that runs your AI.</li>
          <li>Open it and sign in with this account.</li>
          <li>Turn on Use this Mac for my AI. The Mac then shows up here.</li>
        </ol>
        {macApp && (
          <Advanced summary="Other ways">
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
        <p className="text-sm">{wifi ? "On the same Wi-Fi as this computer, scan it in the iPhone app or with the phone's camera." : `Scan it in the iPhone app or with the phone's camera. It opens ${host}.`}</p>
        {code.expiresAt !== Infinity && (
          <p className="text-xs text-muted-foreground">Scanning signs the phone in as you. The code works once; when it runs out, a new one appears here.</p>
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
