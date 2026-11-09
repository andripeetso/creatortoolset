import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Monitor, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { cn } from "@/lib/utils";
import { getComputers, serverUrl, type ComputerInfo, type ComputersView } from "./computers";

/** The line to paste on another computer. The command is not published yet: it arrives with the one-line connect package. */
export const CONNECT_COMMAND = "npx creatortoolset connect";

const ROW = "flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3";

/** A one-time sign-in link for the phone (POST /api/auth/link: 60 s, single use), as a QR code. */
export interface PhoneCode {
  url: string;
  qr: string;
  expiresAt: number;
}

/** Mints a code on this server and draws it. Null when the server won't mint one (not signed in, or unreachable). */
export async function mintPhoneCode(base: string): Promise<PhoneCode | null> {
  try {
    const r = await fetch("/api/auth/link", { method: "POST" });
    if (!r.ok) return null;
    const j = (await r.json()) as { path?: unknown; expiresAt?: unknown };
    if (typeof j.path !== "string" || typeof j.expiresAt !== "number") return null;
    const url = `${base}${j.path}`;
    return { url, qr: await QRCode.toDataURL(url, { margin: 1, width: 176 }), expiresAt: j.expiresAt };
  } catch {
    return null;
  }
}

/** The phone's row: a QR code for a fresh one-time link, a new one on request, and the address as text if no code can be made. */
export function PhoneRow({ base, address }: { base: string; address: string }) {
  const [code, setCode] = useState<PhoneCode | null | undefined>(undefined); // undefined: making one
  const [now, setNow] = useState(() => Date.now());
  const fresh = useCallback(() => {
    setCode(undefined);
    void mintPhoneCode(base).then(setCode);
  }, [base]);
  useEffect(fresh, [fresh]);
  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code]);
  const expired = !!code && code.expiresAt <= now;

  return (
    <div className={cn(ROW, "items-start")}>
      <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <p className="font-medium">Add your phone</p>
        {code === undefined && <p className="text-xs text-muted-foreground">Making a code…</p>}
        {code === null && (
          <p className="text-xs text-muted-foreground">
            Open this address on your phone and sign in: <span className="break-all font-mono text-foreground">{address}</span>
          </p>
        )}
        {code && !expired && (
          <div className="flex flex-wrap items-center gap-4">
            <img src={code.qr} alt="QR code: scan it with your phone to sign in here" width={176} height={176} className="rounded-md bg-white p-1" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs text-muted-foreground">Scan this with your phone's camera. It works once, within a minute.</p>
              <p className="text-xs text-muted-foreground">Away from home, the phone also asks for this computer's password, if one is set.</p>
            </div>
          </div>
        )}
        {code && expired && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">That code has expired.</p>
            <Button size="sm" variant="outline" onClick={fresh}>
              New code
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConnectStepView({
  here,
  others,
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
  signIn,
}: {
  here: string;
  others: ComputerInfo[];
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
  signIn?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className={ROW}>
        <input type="checkbox" checked readOnly aria-label={`${here} is in setup`} className="size-4 accent-[var(--tint)]" />
        <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{here}</p>
          <p className="text-xs text-muted-foreground">This computer</p>
        </div>
        <span className="text-xs text-muted-foreground">Running</span>
      </div>

      {others.length > 0 && (
        <ul className="space-y-2" aria-label="Your computers">
          {others.map((c) => (
            <li key={c.id} className={ROW}>
              <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.online ? "Connected" : "Not running"}</span>
            </li>
          ))}
        </ul>
      )}

      {phone}

      <div className="rounded-xl border border-border/60 bg-card/40">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium"
        >
          Add another computer
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
        {expanded && (
          <div className="space-y-5 border-t border-border/60 px-4 pb-4 pt-3 text-sm">
            <div className="space-y-2">
              <p className="font-medium">Add a computer that runs its own Creator Toolset</p>
              <p className="text-muted-foreground">Paste this into a terminal on each computer you want on your account. It stays connected while Creator Toolset runs there.</p>
              <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2 font-mono text-xs">
                <span>$ {CONNECT_COMMAND}</span>
                <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(CONNECT_COMMAND)}>
                  Copy
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <p className="font-medium">I already have a server</p>
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
          </div>
        )}
      </div>

      {signIn}
    </div>
  );
}

/** Step 1: this computer, the account's other computers, the phone's code, and the folded add-a-computer and existing-server rows. */
export function ConnectStep() {
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

  const base = view?.here.hostname ? `https://${view.here.hostname}` : window.location.origin;
  return (
    <ConnectStepView
      here={view?.here.name ?? "This computer"}
      others={view?.others ?? []}
      phone={<PhoneRow base={base} address={window.location.origin} />}
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
      signIn={
        hasAccountBridge() && (
          <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
            <p className="mb-2 text-sm font-medium">Sign in</p>
            <AccountStep />
          </div>
        )
      }
    />
  );
}
