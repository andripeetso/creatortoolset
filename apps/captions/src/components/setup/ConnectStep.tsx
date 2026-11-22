import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Cloud, Copy, Link as LinkIcon, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { useAuth } from "@/lib/auth";
import { connectThisMac, thisMacLinked } from "@/lib/thisMac";
import { createPairingLink, ms, revokePairingLink, STANDARD, type CreatedLink } from "@/lib/access";
import { PairingLinkCard } from "@/components/settings/PairingLinks";
import { useNow } from "@/components/settings/SignedInClients";
import { cn } from "@/lib/utils";
import { readCached, putCached } from "@/lib/local-cache";
import { serverUrl, useComputers, type ComputerInfo } from "./computers";

/** The id of this computer in the picked set. The account's other computers are listed without a pick. */
export const HERE = "here";
/** The line to paste on another computer. Not published yet: it shows only when SHOW_CONNECT_COMMAND is on. */
export const CONNECT_COMMAND = "npx creatortoolset connect";
/** Turn on with the npm package: the paste line then shows under Add another computer, and nowhere else. */
export const SHOW_CONNECT_COMMAND = false;

const CARD = "rounded-xl border border-border/60 bg-card/40";

/**
 * What the phone row shows: a pairing link made here (with its code, kept only in this page); "signin" (sign in first);
 * "gone" (it ran out or was revoked: Create link makes another); null (no link: the server can't be reached).
 */
export type PhoneState = CreatedLink | "signin" | "gone" | null;
const isLink = (c: PhoneState | undefined): c is CreatedLink => typeof c === "object" && c !== null;
/**
 * The last answer in this browser (lib/local-cache.ts). `true`: a link, whose space is held while the next one is made.
 */
const HAD_CODE = "setup/phone-code";
/** After the phone's row in the step: not drawn while that row's height is not known yet (PhoneRowView's data-unplaced). */
const UNDER_PHONE = "peer-data-[unplaced]/phone:hidden";

/** A Standard pairing link for the phone (Settings → Computers → Phones lists it too). See PhoneState for the other answers. */
export async function mintPhoneLink(): Promise<PhoneState> {
  try {
    return await createPairingLink({ scopes: STANDARD });
  } catch (e) {
    return (e as { status?: number }).status === 401 ? "signin" : null;
  }
}

/**
 * "Add your phone": the same pairing link card as Settings → Computers → Phones, its QR code open. One link is made when
 * the step opens; once it runs out or is revoked, Create link makes the next.
 */
export function PhoneRow({ wait = false }: { wait?: boolean }) {
  const user = useAuth((s) => s.me?.username);
  const had = readCached<boolean>(user, HAD_CODE);
  const [code, setCode] = useState<PhoneState | undefined>(undefined); // undefined: making one
  const latest = useRef(0);
  useEffect(() => {
    if (code !== undefined && code !== "gone") putCached(user, HAD_CODE, isLink(code));
  }, [user, code]);
  // a reply to an older request is dropped, so the screen shows the newest link only
  const fresh = useCallback(() => {
    const mine = ++latest.current;
    setCode(undefined);
    void mintPhoneLink().then((c) => {
      if (mine === latest.current) setCode(c);
    });
  }, []);
  useEffect(fresh, [fresh]);
  const now = useNow(isLink(code));
  const expired = isLink(code) && ms(code.expiresAt) <= now;
  useEffect(() => {
    if (expired) setCode("gone");
  }, [expired]);
  return (
    <PhoneRowView
      code={code}
      hold={had === true}
      wait={wait}
      now={now}
      onCreate={fresh}
      onRevoke={async (id) => {
        await revokePairingLink(id);
        setCode("gone");
      }}
    />
  );
}

export function PhoneRowView({
  code,
  hold = false,
  wait = false,
  now,
  onCreate,
  onRevoke,
}: {
  code: PhoneState | undefined;
  /** the last answer was a link: the line that says one is being made is as tall as the link, so nothing under it moves */
  hold?: boolean;
  /** what is above this row in the step is not known yet (a first visit): the row is not drawn until it is */
  wait?: boolean;
  now: number;
  onCreate: () => void;
  onRevoke: (id: string) => Promise<void>;
}) {
  return (
    // unplaced: this row is waiting, or a link is being made with no space held for it. What comes after it in the step
    // is not drawn then (UNDER_PHONE), so nothing moves when the answer arrives
    <div data-unplaced={wait || (code === undefined && !hold) ? "" : undefined} className={cn(CARD, "peer/phone", wait && "hidden")}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Add your phone</p>
          <p className="text-xs text-muted-foreground">Use Creator Toolset on your phone too. Scan the QR code with your phone's camera.</p>
        </div>
        {(code === "gone" || code === null) && (
          <Button size="sm" variant="outline" onClick={onCreate}>
            Create link
          </Button>
        )}
      </div>
      {code === undefined && <p className={cn("px-4 pb-3 text-xs text-muted-foreground", hold && "h-52")}>Creating a link…</p>}
      {code === null && <p className="px-4 pb-3 text-xs text-muted-foreground">Could not create a link. Check the connection, then try again.</p>}
      {code === "signin" && <p className="px-4 pb-3 text-xs text-muted-foreground">Sign in first, then the link appears here.</p>}
      {isLink(code) && (
        <div className="border-t border-border/60">
          <PairingLinkCard link={code} created={code} now={now} startOpen onRevoke={onRevoke} />
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
  addHere,
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
  /** this Mac, not on the account yet: the button that adds it (and starts its tunnel); absent once it is, or in a browser */
  addHere?: { onAdd: () => void; busy: boolean; problem?: string | null };
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

      {account || others.length > 0 || addHere ? (
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
          {addHere && (
            <div className="space-y-2 border-t border-border/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <p className="flex-1 text-sm text-muted-foreground">
                  {addHere.busy ? "Say yes in your browser to add this computer." : "Open this computer from your other devices."}
                </p>
                <Button size="sm" onClick={addHere.onAdd} disabled={addHere.busy}>
                  Add this computer
                </Button>
              </div>
              {addHere.problem && <p role="status" className="text-xs text-destructive">{addHere.problem}</p>}
            </div>
          )}
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
        <div className={cn(CARD, UNDER_PHONE)}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Creator Toolset runs on the computer you work on. Download the{" "}
            <a className="text-foreground underline" href="https://creatortoolset.com/download">Creator Toolset Mac app</a> there, and it joins this account.
          </p>
        </div>
      ) : (
      <div className={cn(CARD, UNDER_PHONE)}>
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
                2. In that server's Settings → Servers, make a sign-in link and paste it here.
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
  const hosted = useAuth((s) => s.kind === "cloud");
  const { data: view, error, refresh } = useComputers();
  const [expanded, setExpanded] = useState(false);
  const [server, setServer] = useState("");
  const [serverBad, setServerBad] = useState(false);
  const [link, setLink] = useState("");
  const [joinNote, setJoinNote] = useState<{ ok: boolean; text: string } | null>(null);
  // this Mac on the account: asked of the Mac app only (nothing leaves this computer before Add this computer is pressed)
  const [linked, setLinked] = useState<boolean | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!hosted) void thisMacLinked().then(setLinked);
  }, [hosted]);
  const add = async () => {
    setAdding(true);
    setAddProblem(null);
    const problem = await connectThisMac();
    setAdding(false);
    if (problem) setAddProblem(problem);
    else {
      setLinked(true);
      void refresh().catch(() => {});
    }
  };

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
      void refresh().catch(() => {});
    } else setJoinNote({ ok: false, text: j?.message ?? "Could not reach this computer. Try again." });
  };

  return (
    <ConnectStepView
      here={{ name: view?.here.name ?? "This computer", address: `${window.location.origin}/` }}
      others={view?.others ?? []}
      picked={picked}
      onPick={onPick}
      // a first visit: the phone's row and what is under it take their place once the other computers are known (or their read failed)
      phone={<PhoneRow wait={view === null && !error} />}
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
      addHere={linked === false ? { onAdd: () => void add(), busy: adding, problem: addProblem } : undefined}
    />
  );
}
