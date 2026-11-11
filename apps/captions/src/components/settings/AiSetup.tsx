import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { CliId, ConnectResult, LocalAiRow, LocalAiView, SignInResult } from "@contracts/local-ai";
import type { Driver } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { useCachedLoad } from "@/lib/local-cache";
import { msg } from "./helpers";
import { DriverMark } from "./ProviderInstanceCard";
import { ListRow, Status } from "./ui";

/**
 * How to install and sign in a coding tool on a computer, from its own docs: shown when the tool is not there. The site
 * never installs anything on a computer itself: that would make it a way to run commands there. A tool not listed here
 * gets only a line saying to install it there and press Test. The own-computer install (the local routes below) installs
 * and signs in from the app itself, on the computer it runs on.
 */
const TOOLS: Partial<Record<Driver, { name: string; install: string; signIn: string }>> = {
  claude: { name: "Claude Code", install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude" },
  codex: { name: "Codex", install: "npm install -g @openai/codex", signIn: "codex login" },
  gemini: { name: "Gemini CLI", install: "npm install -g @google/gemini-cli", signIn: "gemini" },
};

/** The sign-in command each tool has, for the line that says where to sign in. */
export const SIGN_IN: Partial<Record<Driver, string>> = { codex: "codex login", claude: "claude", grok: "grok login", gemini: "gemini" };

/** The install and sign-in lines for one tool, on its detail page and in the Add provider dialog, when the computer doesn't have it. */
export function InstallHelp({ driver }: { driver: Driver }) {
  const tool = TOOLS[driver];
  if (!tool) {
    return <p className="text-xs text-muted-foreground">Not installed on this computer. Install it there, then press Test.</p>;
  }
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <p>Not installed on this computer. Install {tool.name} in Terminal there:</p>
      <Command text={tool.install} />
      <p>
        Then sign in: run <code>{tool.signIn}</code> once.
      </p>
    </div>
  );
}

/** Where to sign in, for a tool on a computer the app can't sign in on for the person. */
export function SignInHelp({ driver, computer }: { driver: Driver; computer: string }) {
  const cmd = SIGN_IN[driver];
  return (
    <p className="text-xs text-muted-foreground">
      Sign in on {computer}: run {cmd ? <code>{cmd}</code> : "its sign-in"} once in Terminal there.
    </p>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-[11px] text-foreground">{text}</code>
      <Button
        size="icon-xs"
        variant="outline"
        aria-label="Copy command"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/* ---- this computer's own AI apps (the local routes, api/setup.ts): found, installed and signed in from the app ---- */

const LOCAL_CLI: CliId[] = ["claude", "codex", "gemini"];
/** Whether the local routes can install and sign in this tool (the three CLIs the server knows). */
export const isLocalCli = (driver: string): driver is CliId => (LOCAL_CLI as string[]).includes(driver);

async function call<T>(url: string, method: "GET" | "POST", body?: unknown, ms?: number): Promise<T> {
  const r = await fetch(url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), ...(ms ? { signal: AbortSignal.timeout(ms) } : {}) });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!j) throw new Error(`Request failed (${r.status})`);
  if (!r.ok && j.error) throw new Error(j.error);
  return j;
}

/** The AI apps on this computer: found or not, signed in or not (LocalAiView). `local` is false on a hosted server. */
export const getLocalAi = () => call<LocalAiView>("/api/setup/ai", "GET", undefined, 20_000);
/**
 * The same list, its saved copy at once (Providers and Headless access share it). Read again when a computer of this
 * account reports a tool installed or signed in ("devices") and after an install, sign-in or connect started here
 * ("setup", this window's own too: the list takes seconds to read, and the read after an action must not be the one
 * already on its way). Nothing tells a page about a tool set up in Terminal.
 */
export const useLocalAi = () => useCachedLoad<LocalAiView>("/api/setup/ai", getLocalAi, { topic: ["devices", "setup"], own: true });
export const localSignIn = (id: CliId) => call<SignInResult>("/api/setup/ai/signin", "POST", { id });
export const localInstall = (id: CliId) => call<SignInResult>("/api/setup/ai/install", "POST", { id });
/** Connects it as this account's AI through this computer's Mac app (`device`); without one the answer says to open the app. */
export const localConnect = (id: CliId, device: string) => call<ConnectResult>("/api/setup/ai/connect", "POST", { id, device });

/** The rows for the computer's AI apps: each one's real state and the one action that moves it on. */
export function LocalAiRows({ rows, device, onChanged }: { rows: LocalAiRow[]; device: string; onChanged: () => void }) {
  return (
    <>
      {rows.map((r) => (
        <LocalAiItem key={r.id} row={r} device={device} onChanged={onChanged} />
      ))}
    </>
  );
}

function LocalAiItem({ row, device, onChanged }: { row: LocalAiRow; device: string; onChanged: () => void }) {
  const id = row.id as CliId;
  const [busy, setBusy] = useState<"install" | "sign-in" | "connect" | null>(null);
  const [note, setNote] = useState<{ tone: "attention" | "broken"; text: string } | null>(null);
  const [waiting, setWaiting] = useState(false);

  // after a sign-in opens its browser: read again every 3 s until the tool says it is signed in (3 minutes at most)
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(onChanged, 3000);
    const stop = window.setTimeout(() => setWaiting(false), 180_000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [waiting, onChanged]);
  useEffect(() => {
    if (waiting && row.signedIn) setWaiting(false);
  }, [waiting, row.signedIn]);

  // install and sign-in answer { ok }; connect answers { state }: "mac" = the Mac app has to be open (a plain sentence from the server)
  const run = async (kind: "install" | "sign-in" | "connect", fn: () => Promise<SignInResult | ConnectResult>) => {
    setBusy(kind);
    setNote(null);
    try {
      const r = await fn();
      const failed = "state" in r ? r.state !== "ready" : !r.ok;
      if (kind === "sign-in" && !failed) setWaiting(true);
      else if (failed) setNote({ tone: "state" in r && r.state === "mac" ? "attention" : "broken", text: r.message ?? "That didn't work. Try again." });
    } catch (e) {
      setNote({ tone: "broken", text: msg(e) });
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  let status: ReactNode = undefined;
  let action: ReactNode = null;
  if (!row.found) {
    status = <Status tone="attention">Not installed</Status>;
    action = (
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("install", () => localInstall(id))}>
        {busy === "install" ? "Installing…" : "Install"}
      </Button>
    );
  } else if (row.signedIn === false) {
    status = waiting ? <span className="text-muted-foreground">Finish signing in in your browser</span> : <Status tone="attention">Not signed in</Status>;
    action = (
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("sign-in", () => localSignIn(id))}>
        {busy === "sign-in" ? "Opening…" : "Sign in"}
      </Button>
    );
  } else if (!row.connected) {
    action = (
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("connect", () => localConnect(id, device))}>
        {busy === "connect" ? "Connecting…" : "Connect"}
      </Button>
    );
  }
  if (note) status = <Status tone={note.tone}>{note.text}</Status>;

  return (
    <ListRow
      icon={<DriverMark driver={row.id} />}
      title={row.name}
      subtitle={row.found && row.version ? `Version ${row.version}` : undefined}
      status={status}
      actions={action}
    />
  );
}
