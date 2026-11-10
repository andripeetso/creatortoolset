import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Cloud, Copy, Link as LinkIcon, Monitor, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { cn } from "@/lib/utils";
import { getComputers, serverUrl, type ComputerInfo, type ComputersView } from "./computers";

/** The id of this computer in the picked set. The other computers are picked by their device id. */
export const HERE = "here";
/** The line to paste on another computer. The command is not published yet: it arrives with the one-line connect package. */
export const CONNECT_COMMAND = "npx creatortoolset connect";

const CARD = "rounded-xl border border-border/60 bg-card/40";

/** A one-time sign-in link for the phone (POST /api/auth/link: 60 s, single use), as a QR code. */
export interface PhoneCode {
  url: string;
  qr: string;
  expiresAt: number;
}

/**
 * Mints a code on this server and draws it, at the address the server says a phone can reach (its tunnel, the address
 * in use, or its network address). "local": it listens on this computer only. Null: no code (not signed in, unreachable).
 */
export async function mintPhoneCode(): Promise<PhoneCode | "local" | null> {
  try {
    const r = await fetch("/api/auth/link", { method: "POST" });
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
 * "Add your phone": a QR code the phone's camera reads. The code is one-time and lasts about a minute, so a new one is
 * drawn when it runs out (on its own, and by the button).
 */
export function PhoneRow() {
  const [code, setCode] = useState<PhoneCode | "local" | null | undefined>(undefined); // undefined: making one
  const [now, setNow] = useState(() => Date.now());
  const fresh = useCallback(() => {
    setCode(undefined);
    void mintPhoneCode().then(setCode);
  }, []);
  useEffect(fresh, [fresh]);
  useEffect(() => {
    if (!code || code === "local" || code.expiresAt === Infinity) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code]);
  const expired = !!code && code !== "local" && code.expiresAt <= now;
  // a code that ran out is replaced by itself: the person only scans what is on the screen
  useEffect(() => {
    if (expired) fresh();
  }, [expired, fresh]);

  return (
    <div className={cn(CARD, "space-y-3 px-4 py-3")}>
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">Add your phone</p>
          <p className="text-xs text-muted-foreground">Use Creator Toolset on your phone too. Scan this with your phone's camera.</p>
        </div>
      </div>
      {code === undefined && <p className="text-xs text-muted-foreground">Making a code…</p>}
      {code === null && <p className="text-xs text-muted-foreground">Couldn't make a code. Check the connection, then reopen this step.</p>}
      {code === "local" && (
        <p className="text-xs text-muted-foreground">
          Your phone can't reach this computer yet. In the Creator Toolset Mac app, turn on Access from other devices, then come back here.
        </p>
      )}
      {code && code !== "local" && !expired && (
        <div className="flex flex-wrap items-center gap-4">
          <img src={code.qr} alt="QR code: scan it with your phone to sign in here" width={176} height={176} className="rounded-md bg-white p-1" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">The code works once and runs out after a minute, then a new one appears here.</p>
        </div>
      )}
    </div>
  );
}

/** One computer's row: a checkbox, its name and its address, and the mark of a computer that needs attention. */
function ComputerCheck({
  id,
  name,
  detail,
  picked,
  onPick,
  icon,
  attention,
}: {
  id: string;
  name: string;
  detail?: string;
  picked: boolean;
  onPick: (id: string, on: boolean) => void;
  icon: ReactNode;
  attention?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
      <Checkbox checked={picked} onCheckedChange={(v) => onPick(id, v === true)} aria-label={name} />
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {detail && <span className="block truncate font-mono text-xs text-muted-foreground">{detail}</span>}
      </span>
      {attention && <span className="size-2 shrink-0 rounded-full bg-amber-500" role="img" aria-label={attention} title={attention} />}
    </label>
  );
}

export function ConnectStepView({
  here,
  others,
  picked,
  onPick,
  phone,
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
}: {
  here: { name: string; address: string };
  others: ComputerInfo[];
  picked: ReadonlySet<string>;
  onPick: (id: string, on: boolean) => void;
  phone: ReactNode;
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
}) {
  const [signingIn, setSigningIn] = useState(false);
  return (
    <div className="space-y-3">
      <div className={CARD}>
        <ComputerCheck
          id={HERE}
          name={here.name}
          detail={here.address}
          picked={picked.has(HERE)}
          onPick={onPick}
          icon={<Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        />
      </div>

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
                <ComputerCheck
                  id={c.id}
                  name={c.name}
                  picked={picked.has(c.id)}
                  onPick={onPick}
                  icon={<Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  attention={c.online ? undefined : "Not running. Open Creator Toolset on it."}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">No other computers on your account yet.</p>
        )}
        <div className="space-y-2 border-t border-border/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">Run this on each computer you want to connect.</p>
          <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2 font-mono text-xs">
            <span>$ {CONNECT_COMMAND}</span>
            <Button size="icon-sm" variant="ghost" aria-label="Copy the command" title="Copy the command" onClick={() => void navigator.clipboard?.writeText(CONNECT_COMMAND)}>
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>
      </section>

      {phone}

      <div className={CARD}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium"
        >
          <LinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">Add a computer</span>
          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-90")} aria-hidden />
        </button>
        {expanded && (
          <div className="space-y-5 border-t border-border/60 px-4 pb-4 pt-3 text-sm">
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
    </div>
  );
}

/**
 * Stage 1, "Connect your computers": this computer (checked by default), the account's other computers with a checkbox
 * each, the phone's code, and the folded add-a-computer row. `picked` is the set the next stages work on.
 */
export function ConnectStep({ picked, onPick }: { picked: ReadonlySet<string>; onPick: (id: string, on: boolean) => void }) {
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
