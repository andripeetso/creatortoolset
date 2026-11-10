import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Cloud, Copy, Link as LinkIcon, Monitor, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { useAuth } from "@/lib/auth";
import { allowOtherDevices, thisMacBridge } from "@/lib/thisMac";
import { cn } from "@/lib/utils";
import { getComputers, serverUrl, type ComputerInfo, type ComputersView } from "./computers";

/** The id of this computer in the picked set. The account's other computers are listed without a pick. */
export const HERE = "here";
/** The line to paste on another computer. Not published yet: it shows only when SHOW_CONNECT_COMMAND is on. */
export const CONNECT_COMMAND = "npx creatortoolset connect";
/** Turn on with the npm package: the paste line then shows under Add another computer, and nowhere else. */
export const SHOW_CONNECT_COMMAND = false;

const CARD = "rounded-xl border border-border/60 bg-card/40";

/** A one-time sign-in link for the phone (POST /api/auth/link: 60 s, single use), as a QR code. */
export interface PhoneCode {
  url: string;
  qr: string;
  expiresAt: number;
}
/**
 * What the phone row shows: a code; "local" (this server listens on this computer only); "signin" (sign in first);
 * null (no code: the server can't be reached).
 */
export type PhoneState = PhoneCode | "local" | "signin" | null;
const isCode = (c: PhoneState | undefined): c is PhoneCode => typeof c === "object" && c !== null;

/**
 * Mints a code on this server and draws it, at the address the server says a phone can reach (its tunnel, the address
 * in use, or its network address). See PhoneState for the other answers.
 */
export async function mintPhoneCode(): Promise<PhoneState> {
  try {
    const r = await fetch("/api/auth/link", { method: "POST" });
    if (r.status === 401) return "signin";
    if (!r.ok) return null;
    const j = (await r.json()) as { url?: unknown; path?: unknown; expiresAt?: unknown };
    if (j.url === null) return "local";
    if (typeof j.url !== "string") return null;
    const url = `${j.url}${typeof j.path === "string" ? j.path : ""}`;
    const expiresAt = typeof j.expiresAt === "number" ? j.expiresAt : Infinity;
    return { url, qr: await QRCode.toDataURL(url, { margin: 1, width: 176 }), expiresAt };
  } catch {
    return null;
  }
}

/**
 * After the server restarts for a setting change: asks again each second, 20 times at most. The old server answers
 * "local" until it has stopped, so that answer is not final here either.
 */
async function afterRestart(): Promise<PhoneState> {
  for (let tries = 1; ; tries++) {
    const c = await mintPhoneCode();
    if ((c !== null && c !== "local") || tries >= 20) return c;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/**
 * "Add your phone": a QR code the phone's camera reads. The code is one-time and lasts about a minute, so a new one is
 * drawn when it runs out (on its own, and by the button). Only one code is live: the server ends the older ones.
 */
export function PhoneRow() {
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
      if (mine === latest.current) setCode(c);
    });
  }, []);
  useEffect(() => fresh(), [fresh]);
  useEffect(() => {
    if (!isCode(code) || code.expiresAt === Infinity) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code]);
  const expired = isCode(code) && code.expiresAt <= now;
  // a code that ran out is replaced by itself: the person only scans what is on the screen
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
  return (
    <PhoneRowView
      code={code}
      now={now}
      canTurnOn={!!thisMacBridge()}
      turningOn={turningOn}
      problem={problem}
      onTurnOn={() => void turnOn()}
    />
  );
}

export function PhoneRowView({
  code,
  now,
  canTurnOn,
  turningOn,
  problem,
  onTurnOn,
}: {
  code: PhoneState | undefined;
  now: number;
  /** the Mac app is here to turn Access from other devices on */
  canTurnOn: boolean;
  turningOn: boolean;
  problem: string | null;
  onTurnOn: () => void;
}) {
  return (
    <div className={cn(CARD, "space-y-3 px-4 py-3")}>
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">Add your phone</p>
          <p className="text-xs text-muted-foreground">Use Creator Toolset on your phone too. Scan this with your phone's camera, on the same Wi-Fi.</p>
        </div>
      </div>
      {code === undefined && <p className="text-xs text-muted-foreground">Making a code…</p>}
      {code === null && <p className="text-xs text-muted-foreground">Couldn't make a code. Check the connection, then reopen this step.</p>}
      {code === "signin" && <p className="text-xs text-muted-foreground">Sign in first, then this code appears here.</p>}
      {code === "local" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Your phone can't reach this computer yet.
            {!canTurnOn && " In the Creator Toolset Mac app, turn on Access from other devices, then come back here."}
          </p>
          {canTurnOn && (
            <Button size="sm" variant="outline" disabled={turningOn} onClick={onTurnOn}>
              Access from other devices
            </Button>
          )}
        </div>
      )}
      {problem && (
        <p role="status" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {isCode(code) && code.expiresAt > now && (
        <div className="flex flex-wrap items-center gap-4">
          <img src={code.qr} alt="QR code: scan it with your phone to sign in here" width={176} height={176} className="rounded-md bg-white p-1" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">The code works once and runs out after a minute, then a new one appears here.</p>
        </div>
      )}
    </div>
  );
}

/** One computer's line: a checkbox when it can be picked (this computer), its name and address, and the mark of a computer that needs attention. */
function ComputerRow({
  name,
  detail,
  picked,
  onPick,
  icon,
  attention,
}: {
  name: string;
  detail?: string;
  picked?: boolean;
  onPick?: (on: boolean) => void;
  icon: ReactNode;
  attention?: string;
}) {
  const text = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {detail && <span className="block truncate font-mono text-xs text-muted-foreground">{detail}</span>}
      </span>
      {attention && <span className="size-2 shrink-0 rounded-full bg-amber-500" role="img" aria-label={attention} title={attention} />}
    </>
  );
  if (!onPick) return <div className="flex items-center gap-3 px-4 py-3">{text}</div>;
  return (
    <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
      <Checkbox checked={!!picked} onCheckedChange={(v) => onPick(v === true)} aria-label={name} />
      {text}
    </label>
  );
}

export function ConnectStepView({
  here,
  others,
  picked,
  onPick,
  phone,
  pasteCommand,
  expanded,
  onExpand,
  server,
  onServer,
  onServerGo,
  serverBad,
  link,
  onLink,
  onJoin,
  joinNote,
  account,
  hosted = false,
}: {
  here: { name: string; address: string };
  others: ComputerInfo[];
  picked: ReadonlySet<string>;
  onPick: (id: string, on: boolean) => void;
  phone: ReactNode;
  /** the paste line for another computer; absent while the package is not published */
  pasteCommand?: string;
  expanded: boolean;
  onExpand: () => void;
  server: string;
  onServer: (v: string) => void;
  onServerGo: () => void;
  serverBad: boolean;
  link: string;
  onLink: (v: string) => void;
  onJoin: () => void;
  joinNote?: { ok: boolean; text: string } | null;
  /** the account sign-in (AccountStep), when the Mac app can show it */
  account?: ReactNode;
  /** hosted: this server is no computer of the person, so its own row and the add-a-computer form are left out */
  hosted?: boolean;
}) {
  const [signingIn, setSigningIn] = useState(false);
  return (
    <div className="space-y-3">
      {!hosted && (
      <div className={CARD}>
        <ComputerRow
          name={here.name}
          detail={here.address}
          picked={picked.has(HERE)}
          onPick={(on) => onPick(HERE, on)}
          icon={<Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        />
      </div>
      )}

      {account || others.length > 0 ? (
        <section className={CARD} aria-label="Creator Toolset Connect">
          <div className="flex items-center gap-3 px-4 py-3">
            <Cloud className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="flex-1 text-sm font-medium">Creator Toolset Connect</p>
            {account && (
              <button type="button" aria-expanded={signingIn} onClick={() => setSigningIn((v) => !v)} className="text-sm text-muted-foreground hover:text-foreground">
                Sign in ›
              </button>
            )}
          </div>
          {signingIn && account && <div className="border-t border-border/60 px-4 py-3">{account}</div>}
          {others.length > 0 ? (
            <ul className="divide-y divide-border/60 border-t border-border/60" aria-label="Your other computers">
              {others.map((c) => (
                <li key={c.id}>
                  <ComputerRow
                    name={c.name}
                    icon={<Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    attention={c.online ? undefined : "Not running. Open Creator Toolset on it."}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {phone}

      {hosted ? (
        <div className={CARD}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Creator Toolset runs on the computer you work on. Download the{" "}
            <a className="text-foreground underline" href="https://creatortoolset.com/download">Creator Toolset Mac app</a> there, and it joins this account.
          </p>
        </div>
      ) : (
      <div className={CARD}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium"
        >
          <LinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">Add another computer</span>
          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-90")} aria-hidden />
        </button>
        {expanded && (
          <div className="space-y-5 border-t border-border/60 px-4 pb-4 pt-3 text-sm">
            {pasteCommand && (
              <div className="space-y-2">
                <p className="text-muted-foreground">Run this on each computer you want to connect.</p>
                <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2 font-mono text-xs">
                  <span>$ {pasteCommand}</span>
                  <Button size="icon-sm" variant="ghost" aria-label="Copy the command" title="Copy the command" onClick={() => void navigator.clipboard?.writeText(pasteCommand)}>
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
            <p className="text-muted-foreground">If your computer runs Creator Toolset on its own server, join it here with a link from that server.</p>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                onServerGo();
              }}
            >
              <label htmlFor="ct-server-address" className="block text-xs text-muted-foreground">
                1. Its address, like studio.example.com. It opens in a new tab, where you sign in.
              </label>
              <div className="flex gap-2">
                <input
                  id="ct-server-address"
                  value={server}
                  onChange={(e) => onServer(e.target.value)}
                  placeholder="studio.example.com"
                  autoComplete="off"
                  inputMode="url"
                  aria-invalid={serverBad || undefined}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
                <Button size="sm" type="submit" variant="outline">
                  Open
                </Button>
              </div>
              {serverBad && <p className="text-xs text-destructive">Enter a web address, like studio.example.com. Plain http works only on this network.</p>}
            </form>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                onJoin();
              }}
            >
              <label htmlFor="ct-server-link" className="block text-xs text-muted-foreground">
                2. On that server's Devices page, press "Sign in another computer", and paste the link it shows here.
              </label>
              <div className="flex gap-2">
                <input
                  id="ct-server-link"
                  value={link}
                  onChange={(e) => onLink(e.target.value)}
                  placeholder="https://studio.example.com/api/auth/link/…"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
                <Button size="sm" type="submit" variant="outline" disabled={!link.trim()}>
                  Join
                </Button>
              </div>
              {joinNote && <p role="status" className={cn("text-xs", joinNote.ok ? "text-muted-foreground" : "text-destructive")}>{joinNote.text}</p>}
            </form>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * Stage 1, "Connect your computers": this computer (checked by default), the account's other computers, the phone's
 * code, and the folded Add another computer row. `picked` is the set the next stages work on.
 */
export function ConnectStep({ picked, onPick }: { picked: ReadonlySet<string>; onPick: (id: string, on: boolean) => void }) {
  const hosted = useAuth((s) => s.hosted);
  const [view, setView] = useState<ComputersView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [server, setServer] = useState("");
  const [serverBad, setServerBad] = useState(false);
  const [link, setLink] = useState("");
  const [joinNote, setJoinNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void getComputers().then(setView);
  }, []);

  const go = () => {
    const url = serverUrl(server);
    setServerBad(!url);
    if (url) window.open(`${url}/?setup=connect`, "_blank", "noopener");
  };

  const join = async () => {
    setJoinNote(null);
    const r = await fetch("/api/setup/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link: link.trim() }),
    }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { ok?: boolean; server?: string; device?: { name?: string }; message?: string } | null;
    if (j?.ok) {
      setLink("");
      setJoinNote({ ok: true, text: `Joined ${j.server}${j.device?.name ? ` as ${j.device.name}` : ""}.` });
      void getComputers().then(setView);
    } else setJoinNote({ ok: false, text: j?.message ?? "Couldn't reach this computer. Try again." });
  };

  return (
    <ConnectStepView
      here={{ name: view?.here.name ?? "This computer", address: `${window.location.origin}/` }}
      others={view?.others ?? []}
      picked={picked}
      onPick={onPick}
      phone={<PhoneRow />}
      hosted={hosted}
      pasteCommand={SHOW_CONNECT_COMMAND ? CONNECT_COMMAND : undefined}
      expanded={expanded}
      onExpand={() => setExpanded((v) => !v)}
      server={server}
      onServer={(v) => {
        setServer(v);
        setServerBad(false);
      }}
      onServerGo={go}
      serverBad={serverBad}
      link={link}
      onLink={(v) => {
        setLink(v);
        setJoinNote(null);
      }}
      onJoin={() => void join()}
      joinNote={joinNote}
      account={hasAccountBridge() ? <AccountStep /> : undefined}
    />
  );
}
