import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { INSTALL_LINE, type CliId, type ConnectResult, type LocalAiId, type LocalAiRow, type LocalAiView, type SignInResult } from "@contracts/local-ai";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/settings/ProviderLogos";

export type Phase = "connecting" | "signingIn" | "timedOut";
export type Results = Partial<Record<LocalAiId, ConnectResult>>;
export type Phases = Partial<Record<LocalAiId, Phase>>;
type Action = "connect" | "signin" | "check";

const WAIT_MS = 3 * 60_000;
const POLL_MS = 3_000;
/** How long a request may take before it gives up with a plain message (no wait spins forever). */
const TIMEOUT_MS = 90_000;

/** The agents this step lists, in order. Gemini CLI installs on its own, so it has no Install button. */
const AGENTS: CliId[] = ["claude", "codex", "gemini"];
const NAME: Record<CliId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
const COMMAND: Record<CliId, string> = { claude: "claude", codex: "codex", gemini: "gemini" };
const DESCRIBE: Record<CliId, string> = {
  claude: "Code with your Claude subscription.",
  codex: "Code with your ChatGPT subscription.",
  gemini: "Google's coding tool. Sign in with your Google account.",
};
const SIGN_IN: Record<CliId, string> = { claude: "Continue with Claude", codex: "Continue with ChatGPT", gemini: "Sign in" };
const TERMINAL_HINT = "A Terminal window opens. Sign in there with your browser, then come back here.";
const DESKTOP_LINE: Partial<Record<LocalAiId, string>> = {
  "claude-desktop": "The Claude app. It can't be the AI this app uses, and it can't be connected from here yet.",
  "chatgpt-desktop": "The ChatGPT app. It can't be the AI this app uses, and it can't be connected from here yet.",
};

const isCli = (id: LocalAiId): id is CliId => id === "claude" || id === "codex" || id === "gemini";
const plain = (msg: string) => msg.replace(/\.+$/, "");
const isConnected = (row: LocalAiRow, result?: ConnectResult) => row.connected || result?.state === "ready";

/** The app's own AI has a passing check: saved from before, or this session's Connect. */
export const anyConnected = (view: LocalAiView | null, results: Results): boolean =>
  !!view?.rows.some((r) => isCli(r.id) && isConnected(r, results[r.id]));

export interface RowView {
  line: string;
  hint?: string;
  button: { label: string; action: Action | "none"; disabled?: boolean } | null;
  connected?: boolean;
  raw?: string;
}

/**
 * What one agent's row says, checked in order: an in-progress step first, then this session's last Connect, then the
 * probe. "Connected" only after a passing check, so a failed part never shows it.
 */
export function rowView(row: LocalAiRow, result: ConnectResult | undefined, phase: Phase | undefined): RowView {
  const connected = isConnected(row, result);
  const signed = row.signedIn ?? (result?.state === "ready" ? true : null);
  const notSignedIn: RowView = { line: "Not signed in yet. " + TERMINAL_HINT, button: { label: "Sign in", action: "signin" } };
  if (phase === "connecting") return { line: "Checking. This can take up to a minute.", button: { label: "Checking…", action: "connect", disabled: true } };
  if (phase === "signingIn")
    return {
      line: "A Terminal window opened. Sign in there, then come back here. This page checks by itself.",
      button: { label: "Waiting for sign-in…", action: "none", disabled: true },
    };
  if (phase === "timedOut") return { line: "Still not signed in. Sign in in the Terminal window, then press Check again.", button: { label: "Check again", action: "check" } };
  if (result?.state === "failed")
    return {
      line: `It didn't answer: ${plain(result.message ?? "Try again")}.`,
      button: { label: "Try again", action: "connect" },
      raw: result.raw,
    };
  if (result?.state === "mac" || result?.state === "unsupported") return { line: result.message ?? "Open the Creator Toolset Mac app to connect your AI.", button: null };
  if (result?.state === "signin") return notSignedIn;
  if (connected && signed === false)
    return { line: "Connected, but not signed in right now. Sign in again.", button: { label: "Sign in", action: "signin" } };
  if (connected) return { line: "", button: null, connected: true };
  if (signed === false) return notSignedIn;
  if (signed === true) return { line: "Signed in. Ready to connect.", button: { label: "Use existing CLI", action: "connect" } };
  return { line: "", button: { label: "Use existing CLI", action: "connect" } };
}

/** The row's view: the same rules for every agent (the app's own AI can be any of them now). */
export const viewOf = (row: LocalAiRow, result?: ConnectResult, phase?: Phase): RowView => rowView(row, result, phase);

/** The agent's row in the list: logo, name, its description, and on the right the one action it needs. */
function AgentRow({
  id,
  found,
  row,
  result,
  phase,
  installing,
  onAction,
  onInstall,
}: {
  id: CliId;
  found: boolean;
  row?: LocalAiRow;
  result?: ConnectResult;
  phase?: Phase;
  installing: boolean;
  onAction: (a: Action) => void;
  onInstall?: (id: CliId) => void;
}) {
  const v = row ? viewOf(row, result, phase) : null;
  const b = v?.button ?? null;
  const version = row?.version?.replace(/\s*\([^)]*\)\s*$/, "");
  const canInstall = !found && !!INSTALL_LINE[id] && !!onInstall;
  const label = b?.action === "signin" ? SIGN_IN[id] : b?.label;
  return (
    <li className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <ProviderLogo driver={id} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {NAME[id]}
          {version && <span className="ml-2 text-xs font-normal text-muted-foreground">{version}</span>}
        </p>
        <p className="text-xs text-muted-foreground">{DESCRIBE[id]}</p>
        {!found && (
          <p className="text-xs">
            Not found · {NAME[id]} (<code className="font-mono">{COMMAND[id]}</code>) was not found on PATH.
          </p>
        )}
        {found && v?.line && <p className="text-xs">{v.line}</p>}
        {v?.raw && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Details</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{v.raw}</pre>
          </details>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {v?.connected && <Check aria-label={`${NAME[id]} is connected`} className="size-4 text-emerald-600 dark:text-emerald-400" />}
        {b && (
          <Button
            size="sm"
            variant={b.action === "signin" || b.action === "check" ? "default" : "outline"}
            disabled={b.disabled}
            onClick={() => {
              if (b.action !== "none") onAction(b.action);
            }}
          >
            {label}
          </Button>
        )}
        {canInstall && (
          <Button size="sm" variant="outline" disabled={installing} onClick={() => onInstall?.(id)}>
            <span aria-hidden className="font-mono">›_</span> Install
          </Button>
        )}
      </div>
    </li>
  );
}

export interface AiPanelViewProps {
  view: LocalAiView | null;
  results: Results;
  phases: Phases;
  installing?: boolean;
  installMsg?: string | null;
  onAction: (id: CliId, action: Action) => void;
  onInstall?: (id: CliId) => void;
  onRefresh: () => void;
}

/** The agents on this computer: one row each, found or not, and the desktop apps it can see. Pure, for tests. */
export function AiPanelView({ view, results, phases, installing = false, installMsg, onAction, onInstall, onRefresh }: AiPanelViewProps) {
  if (!view) return <p className="text-sm text-muted-foreground">Looking for your AI on this computer…</p>;
  if (!view.local)
    return <p className="text-sm text-muted-foreground">Ask the owner of this server to connect the AI it runs on.</p>;
  const desktops = view.rows.filter((r) => r.kind === "desktop");
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {AGENTS.map((id) => {
          const row = view.rows.find((r) => r.id === id);
          return (
            <AgentRow
              key={id}
              id={id}
              found={!!row?.found}
              row={row}
              result={results[id]}
              phase={phases[id]}
              installing={installing}
              onAction={(a) => onAction(id, a)}
              onInstall={onInstall}
            />
          );
        })}
        {desktops.map((r) => (
          <li key={r.id} className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{r.name}</p>
              <p className="text-xs text-muted-foreground">{DESKTOP_LINE[r.id]}</p>
            </div>
          </li>
        ))}
      </ul>
      {installMsg && <p role="status" className="text-xs text-muted-foreground">{installMsg}</p>}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          Check again
        </Button>
      </div>
    </div>
  );
}

/** One request, bounded: no answer in time (or no server) is null, which the caller turns into a plain message. */
async function request<T>(url: string, init?: RequestInit): Promise<T | null> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
const getJson = <T,>(url: string) => request<T>(url);
const postJson = <T,>(url: string, body: unknown) =>
  request<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * The agents on this computer, with the server behind them: reads what the computer has, and runs Connect, Sign in and
 * Install only when the person presses them. "Check again" re-reads the computer (no cached answer). After Sign in it
 * checks by itself every few seconds for up to three minutes.
 */
export function AiPanel({ onConnectedChange }: { onConnectedChange?: (on: boolean) => void }) {
  const [view, setView] = useState<LocalAiView | null>(null);
  const [results, setResults] = useState<Results>({});
  const [phases, setPhases] = useState<Phases>({});
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  // fresh: Check again. The server re-reads PATH and the sign-in; a plain read may answer from its last look.
  const refresh = useCallback(async (fresh = false) => {
    const v = await getJson<LocalAiView>(fresh ? "/api/setup/ai?fresh=1" : "/api/setup/ai");
    if (v) setView(v);
    return v;
  }, []);
  const setPhase = (id: LocalAiId, p: Phase | undefined) => setPhases((s) => ({ ...s, [id]: p }));

  const connect = useCallback(
    async (id: CliId) => {
      setPhase(id, "connecting");
      const r = await postJson<ConnectResult>("/api/setup/ai/connect", { id });
      setResults((s) => ({ ...s, [id]: r ?? { state: "failed", signedIn: null, answered: null, message: "it took too long or couldn't be reached, so try again" } }));
      setPhase(id, undefined);
      await refresh(true);
    },
    [refresh],
  );

  const waitForSignIn = (id: CliId) => {
    setPhase(id, "signingIn");
    const started = Date.now();
    const t = window.setInterval(async () => {
      const v = await refresh(true);
      if (v?.rows.find((r) => r.id === id)?.signedIn) {
        window.clearInterval(t);
        void connect(id);
      } else if (Date.now() - started > WAIT_MS) {
        window.clearInterval(t);
        setPhase(id, "timedOut");
      }
    }, POLL_MS);
    timers.current.push(t);
  };

  const signIn = async (id: CliId) => {
    const r = await postJson<SignInResult>("/api/setup/ai/signin", { id });
    if (!r?.ok) {
      setResults((s) => ({ ...s, [id]: { state: "signin", signedIn: false, answered: null, message: r?.message } }));
      return;
    }
    waitForSignIn(id);
  };

  const install = async (id: CliId) => {
    setInstalling(true);
    const r = await postJson<SignInResult>("/api/setup/ai/install", { id });
    setInstalling(false);
    if (!r?.ok) setInstallMsg(`${r?.message ?? "Couldn't reach this computer. Try again."} The install line: ${INSTALL_LINE[id]}`);
    else setInstallMsg("A Terminal window opened. Let the install finish there, then press Check again.");
  };

  useEffect(() => {
    void refresh();
    const list = timers.current;
    return () => list.forEach((t) => window.clearInterval(t));
  }, [refresh]);

  useEffect(() => {
    onConnectedChange?.(anyConnected(view, results));
  }, [view, results, onConnectedChange]);

  return (
    <AiPanelView
      view={view}
      results={results}
      phases={phases}
      installing={installing}
      installMsg={installMsg}
      onAction={(id, action) => (action === "signin" ? void signIn(id) : void connect(id))}
      onInstall={(id) => void install(id)}
      onRefresh={() => void refresh(true)}
    />
  );
}
