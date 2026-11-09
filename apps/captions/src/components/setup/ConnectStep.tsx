import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { cn } from "@/lib/utils";
import { getComputers, serverUrl, type ComputerInfo, type ComputersView } from "./computers";

/** The line to paste on another computer. The command is not published yet: it arrives with the one-line connect package. */
export const CONNECT_COMMAND = "npx creatortoolset connect";

const ROW = "flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3";

export function ConnectStepView({
  here,
  others,
  address,
  expanded,
  onExpand,
  server,
  onServer,
  onServerGo,
  serverBad,
  signIn,
}: {
  here: string;
  others: ComputerInfo[];
  address: string;
  expanded: boolean;
  onExpand: () => void;
  server: string;
  onServer: (v: string) => void;
  onServerGo: () => void;
  serverBad: boolean;
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

      <div className={ROW}>
        <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Add your phone</p>
          <p className="text-xs text-muted-foreground">
            Open this address on your phone and sign in: <span className="break-all font-mono text-foreground">{address}</span>
          </p>
        </div>
      </div>

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
          <div className="space-y-4 border-t border-border/60 px-4 pb-4 pt-3 text-sm">
            <div className="space-y-2">
              <p className="text-muted-foreground">Paste this into a terminal on each computer you want on your account. It stays connected while Creator Toolset runs there.</p>
              <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2 font-mono text-xs">
                <span>$ {CONNECT_COMMAND}</span>
                <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(CONNECT_COMMAND)}>
                  Copy
                </Button>
              </div>
            </div>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                onServerGo();
              }}
            >
              <label htmlFor="ct-server-address" className="block font-medium">
                I already have a server
              </label>
              <p className="text-xs text-muted-foreground">Its address, like studio.example.com. It opens in a new tab, where you sign in there.</p>
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
          </div>
        )}
      </div>

      {signIn}
    </div>
  );
}

/** Step 1: this computer, the account's other computers, the phone, and the folded add-a-computer and existing-server rows. */
export function ConnectStep() {
  const [view, setView] = useState<ComputersView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [server, setServer] = useState("");
  const [serverBad, setServerBad] = useState(false);
  useEffect(() => {
    void getComputers().then(setView);
  }, []);

  const go = () => {
    const url = serverUrl(server);
    setServerBad(!url);
    if (url) window.open(`${url}/?setup=connect`, "_blank", "noopener");
  };

  return (
    <ConnectStepView
      here={view?.here.name ?? "This computer"}
      others={view?.others ?? []}
      address={window.location.origin}
      expanded={expanded}
      onExpand={() => setExpanded((v) => !v)}
      server={server}
      onServer={(v) => {
        setServer(v);
        setServerBad(false);
      }}
      onServerGo={go}
      serverBad={serverBad}
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
