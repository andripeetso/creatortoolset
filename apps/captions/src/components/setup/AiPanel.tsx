import { useCallback, useEffect, useRef, useState } from "react";
import type { CliId, ConnectResult, LocalAiId, LocalAiRow, LocalAiView, McpResult, SignInResult } from "@contracts/local-ai";
import { PLANS } from "@contracts/plans";
import type { WorkPrefs } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { CopyButton } from "@/components/workshop/CopyButton";

type Talk = WorkPrefs["talk"];
export type Phase = "connecting" | "signingIn" | "timedOut";
export type Results = Partial<Record<LocalAiId, ConnectResult>>;
export type Phases = Partial<Record<LocalAiId, Phase>>;
export interface McpState {
  busy?: boolean;
  done?: boolean;
  message?: string;
}
export type McpStates = Partial<Record<LocalAiId, McpState>>;
type Action = "connect" | "signin" | "check";

const WAIT_MS = 3 * 60_000;
const POLL_MS = 3_000;
const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const CODEX_INSTALL = "npm install -g @openai/codex";
/** Said once under the list (not on every row): sign-in opens a Terminal window. */
const TERMINAL_HINT = "A Terminal window opens. That's normal: sign in there with your browser, then come back.";


const BLURB: Partial<Record<LocalAiId, string>> = {
  claude: "Anthropic's coding tool. Runs the app's AI.",
  codex: "Codex can use Creator Toolset from your own chats. The app's own AI runs on Claude Code for now.",
  gemini: "Google's coding tool. Runs the app's AI.",
  "claude-desktop": "The Claude app. It can't be the AI this app uses, and it can't be connected from here yet.",
  "chatgpt-desktop": "The ChatGPT app. It can't be the AI this app uses, and it can't be connected from here yet.",
};

const isCli = (id: LocalAiId): id is CliId => id === "claude" || id === "codex" || id === "gemini";
const plain = (msg: string) => msg.replace(/\.+$/, "");
const isConnected = (row: LocalAiRow, result?: ConnectResult) => row.connected || result?.state === "ready";
/** Only these can be the app's own AI: the Mac relay runs Claude Code and Gemini CLI (apps/mac ClaudeRequest.swift). */
const runsAppAi = (id: LocalAiId): boolean => id === "claude" || id === "gemini";
/** How long a request may take before it gives up with a plain message (no wait spins forever). */
const TIMEOUT_MS = 90_000;

/** The app's own AI has a passing check: saved from before, or this session's Connect. Drives "Continue without connecting". */
export const anyConnected = (view: LocalAiView | null, results: Results): boolean =>
  !!view?.rows.some((r) => isCli(r.id) && runsAppAi(r.id) && isConnected(r, results[r.id]));

export interface RowView {
  line: string;
  hint?: string;
  answered?: string;
  button: { label: string; action: Action | "none"; disabled?: boolean } | null;
  ticks: { signedIn?: boolean; answers?: boolean };
  connected?: boolean;
  raw?: string;
}

/**
 * What one CLI row says, checked in order (SPEC 6.3): an in-progress step first, then this session's last Connect, then
 * the probe. "Connected" only after a passing check, so a failed part never shows it.
 */
export function rowView(row: LocalAiRow, result: ConnectResult | undefined, phase: Phase | undefined): RowView {
  const connected = isConnected(row, result);
  const signed = row.signedIn ?? (result?.state === "ready" ? true : null);
  const signedTick = signed === true ? { signedIn: true } : {};
  const notSignedIn: RowView = {
    line: "Not signed in yet.",
    hint: TERMINAL_HINT,
    button: { label: "Sign in", action: "signin" },
    ticks: {},
  };
  if (phase === "connecting") return { line: "Checking. This can take up to a minute.", button: { label: "Checking…", action: "connect", disabled: true }, ticks: signedTick };
  if (phase === "signingIn")
    return {
      line: "A Terminal window opened. Sign in there, then come back here. This page checks by itself.",
      button: { label: "Waiting for sign-in…", action: "none", disabled: true },
      ticks: {},
    };
  if (phase === "timedOut") return { line: "Still not signed in. Sign in in the Terminal window, then press Check.", button: { label: "Check", action: "check" }, ticks: {} };
  if (result?.state === "failed")
    return {
      line: `It didn't answer: ${plain(result.message ?? "Try again")}.`,
      button: { label: "Try again", action: "connect" },
      ticks: { ...signedTick, answers: false },
      raw: result.raw,
    };
  if (result?.state === "mac" || result?.state === "unsupported") return { line: result.message ?? "Open the Creator Toolset Mac app to connect your AI.", button: null, ticks: {} };
  if (result?.state === "signin") return notSignedIn;
  if (connected && signed === false)
    return { line: "Connected, but not signed in right now. Sign in again.", button: { label: "Sign in", action: "signin" }, ticks: { answers: true } };
  if (connected)
    return {
      line: "Connected.",
      answered: answeredIn(result?.ms ?? row.lastCheck?.ms),
      button: { label: "Connected ✓", action: "none", disabled: true },
      ticks: { ...signedTick, answers: true },
      connected: true,
    };
  if (signed === false) return notSignedIn;
  if (signed === true) return { line: "Signed in. Ready to connect.", button: { label: "Connect", action: "connect" }, ticks: signedTick };
  return { line: "Ready to check.", button: { label: "Connect", action: "connect" }, ticks: {} };
}

/**
 * Codex can't be the app's AI, so its row has no Connect: sign-in on the own-AI paths (then the Creator Toolset action
 * in McpBlock), and no action at all on the app path. Its one plain line is its description (BLURB).
 */
export function codexRowView(row: LocalAiRow, talk: Talk): RowView {
  if (talk === "app") return { line: "", button: null, ticks: {} };
  if (row.signedIn === true) return { line: "Signed in.", button: null, ticks: { signedIn: true } };
  return { line: "Not signed in yet.", hint: TERMINAL_HINT, button: { label: "Sign in", action: "signin" }, ticks: {} };
}

/** The row's view for this path: Codex has its own, every other tool is checked as before. */
export const viewOf = (row: LocalAiRow, talk: Talk, result?: ConnectResult, phase?: Phase): RowView =>
  row.id === "codex" ? codexRowView(row, talk) : rowView(row, result, phase);

const answeredIn = (ms?: number) => (ms == null ? undefined : `Answered in ${(ms / 1000).toFixed(1)} s.`);

function Ticks({ t }: { t: RowView["ticks"] }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {t.signedIn && <span>Signed in ✓</span>}
      {t.answers === true && <span>Answers ✓</span>}
      {t.answers === false && <span>Answers ✗</span>}
    </p>
  );
}

/** The Creator Toolset action under a connected Claude Code or Codex row: off until clicked (SPEC 6.5). */
function McpBlock({ row, talk, state, onAdd }: { row: LocalAiRow; talk: Talk; state?: McpState; onAdd: () => void }) {
  // Codex has no Connect (it can't be the app's AI), so its action shows once it is signed in
  const ready = row.connected || (row.id === "codex" && row.signedIn === true);
  if (talk === "app" || !ready || !isCli(row.id) || row.mcp === "n/a") return null;
  if (row.mcp === "added" || state?.done)
    return (
      <div className="rounded-lg bg-muted/40 p-3 text-xs">
        <p className="font-medium">Added to {row.name} ✓</p>
        <p className="text-muted-foreground">You can see it in Settings → Your AI.</p>
      </div>
    );
  if (row.mcp === "update")
    return (
      <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs">
        <p>Codex needs an update before it can use Creator Toolset.</p>
        {row.updateCommand && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">How to update</summary>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono">{row.updateCommand}</code>
              <CopyButton text={() => row.updateCommand ?? ""} title="Copy the command" label="Copy" className="flex items-center gap-1 rounded border px-2 py-1" />
            </div>
          </details>
        )}
      </div>
    );
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs">
      <p className="text-muted-foreground">So you can ask {row.name} to make captions, plan reels or check a cut here, from your own chat.</p>
      {state?.message && (
        <p className="text-rose-500">
          Creator Toolset couldn't be added to {row.name}: {plain(state.message)}. Your AI is still connected.
        </p>
      )}
      <Button size="sm" variant="outline" disabled={state?.busy} onClick={onAdd}>
        {state?.busy ? "Adding…" : state?.message ? "Try again" : `Let ${row.name} use Creator Toolset`}
      </Button>
    </div>
  );
}

function AiRow({
  row, talk, result, phase, mcp, onAction, onAdd,
}: {
  row: LocalAiRow;
  talk: Talk;
  result?: ConnectResult;
  phase?: Phase;
  mcp?: McpState;
  onAction: (a: Action) => void;
  onAdd: () => void;
}) {
  const v = viewOf(row, talk, result, phase);
  const plan = PLANS.find((p) => p.id === row.plan)?.label ?? row.plan;
  // the tool's own name is already the row's title: "2.1.310 (Claude Code)" shows as "2.1.310"
  const version = row.version?.replace(/\s*\([^)]*\)\s*$/, "");
  const b = v.button;
  return (
    <li className="space-y-1.5 rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {row.name}
            {version && <span className="ml-2 text-xs font-normal text-muted-foreground">{version}</span>}
          </p>
          {BLURB[row.id] && <p className="text-xs text-muted-foreground">{BLURB[row.id]}</p>}
        </div>
        {b && (
          <Button
            size="sm"
            variant={b.action === "connect" || b.action === "signin" || b.action === "check" ? "default" : "outline"}
            disabled={b.disabled}
            className="shrink-0"
            onClick={() => {
              if (b.action !== "none") onAction(b.action);
            }}
          >
            {b.label}
          </Button>
        )}
      </div>
      {v.line && <p className="text-sm">{v.line}</p>}
      {v.answered && <p className="text-xs text-muted-foreground">{v.answered}</p>}
      {row.plan && (
        <>
          <p className="text-xs text-muted-foreground">Plan: {plan}, read from {row.name}.</p>
          <p className="text-[11px] text-muted-foreground">Wrong? Change it in Settings → Setup → Your plan.</p>
        </>
      )}
      <Ticks t={v.ticks} />
      {v.raw && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{v.raw}</pre>
        </details>
      )}
      {v.connected && <p className="text-xs text-muted-foreground">Manage in Settings → Your AI</p>}
      <McpBlock row={row} talk={talk} state={mcp} onAdd={onAdd} />
    </li>
  );
}

function NotFound({ onRefresh, talk }: { onRefresh: () => void; talk: Talk }) {
  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <p className="text-sm">
        {talk === "app"
          ? "Creator Toolset's own AI runs on Claude Code. Claude Code isn't on this Mac yet."
          : "Creator Toolset needs Claude Code or Codex on this Mac. Neither is installed yet."}
      </p>
      <details>
        <summary className="cursor-pointer text-sm font-medium">How to get Claude Code</summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
          <li>Open Terminal (press Command and Space, type Terminal, press Return).</li>
          <li className="space-y-1">
            <span>Paste this line and press Return:</span>
            <span className="flex items-center gap-2">
              <code className="min-w-0 truncate font-mono text-xs">{INSTALL}</code>
              <CopyButton text={() => INSTALL} title="Copy the line" label="Copy" className="flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-xs" />
            </span>
          </li>
          <li>Come back here and press Check again.</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          {talk !== "app" && (
            <>
              Or Codex from OpenAI: install Node.js, then paste <code className="font-mono">{CODEX_INSTALL}</code>.
            </>
          )}
        </p>
      </details>
      <Button size="sm" variant="outline" onClick={onRefresh}>
        Check again
      </Button>
    </div>
  );
}

function AnthropicKey() {
  return (
    <details className="group rounded-xl border border-border/60 bg-card/40">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">Use an Anthropic API key instead</summary>
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">Create a key on Anthropic's website. You pay Anthropic for what you use.</p>
        <MyKeysSection only={["ANTHROPIC_API_KEY"]} />
      </div>
    </details>
  );
}

export interface AiPanelViewProps {
  view: LocalAiView | null;
  talk: Talk;
  results: Results;
  phases: Phases;
  mcp: McpStates;
  onAction: (id: CliId, action: Action) => void;
  onAdd: (id: CliId) => void;
  onRefresh: () => void;
}

/** Step 4's body, from the probe's view: the rows the Mac has, nothing connected until a press (pure, for tests). */
export function AiPanelView({ view, talk, results, phases, mcp, onAction, onAdd, onRefresh }: AiPanelViewProps) {
  if (!view) return <p className="text-sm text-muted-foreground">Looking for your AI on this Mac…</p>;
  const found = view.rows.filter((r) => r.found);
  const clis = found.filter((r) => r.kind === "cli");
  const desktops = found.filter((r) => r.kind === "desktop");
  if (!view.local)
    return (
      <div className="space-y-4">
        <p className="text-sm">Open the Creator Toolset Mac app to connect your AI. Browsers can't reach your Claude or Codex.</p>
        <AnthropicKey />
      </div>
    );
  // the app's own AI needs Claude Code (or Gemini CLI); on the own-AI paths any CLI found is enough to show the list
  const needsInstall = talk === "app" ? !clis.some((r) => runsAppAi(r.id)) : clis.length === 0;
  return (
    <div className="space-y-2">
      {clis.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Found on this Mac</h3>
          <ul className="space-y-1.5">
            {clis.map((r) => (
              <AiRow
                key={r.id}
                row={r}
                talk={talk}
                result={results[r.id]}
                phase={phases[r.id]}
                mcp={mcp[r.id]}
                onAction={(a) => onAction(r.id as CliId, a)}
                onAdd={() => onAdd(r.id as CliId)}
              />
            ))}
          </ul>
          {clis.some((r) => viewOf(r, talk, results[r.id], phases[r.id]).hint) && <p className="text-xs text-muted-foreground">{TERMINAL_HINT}</p>}
        </section>
      )}
      {needsInstall && <NotFound talk={talk} onRefresh={onRefresh} />}
      <details className="group rounded-xl border border-border/60 bg-card/40">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">Other options</summary>
        <div className="space-y-3 px-4 pb-4">
          <AnthropicKey />
          {desktops.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Also on this Mac</p>
              <ul className="space-y-1">
              {desktops.map((r) => (
                <li key={r.id} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{r.name}.</span> {BLURB[r.id]}
                </li>
              ))}
              </ul>
            </div>
          )}
        </div>
      </details>
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
 * Step 4 with the server behind it: reads the Mac's AI, and runs Connect, Sign in and the Creator Toolset action only
 * when the person presses them. After Sign in it checks by itself every few seconds for up to three minutes.
 */
export function AiPanel({ talk, onConnectedChange }: { talk: Talk; onConnectedChange?: (on: boolean) => void }) {
  const [view, setView] = useState<LocalAiView | null>(null);
  const [results, setResults] = useState<Results>({});
  const [phases, setPhases] = useState<Phases>({});
  const [mcp, setMcp] = useState<McpStates>({});
  const timers = useRef<number[]>([]);

  const refresh = useCallback(async () => {
    const v = await getJson<LocalAiView>("/api/setup/ai");
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
      await refresh();
    },
    [refresh],
  );

  const waitForSignIn = (id: CliId) => {
    setPhase(id, "signingIn");
    const started = Date.now();
    const t = window.setInterval(async () => {
      const v = await refresh();
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

  const addMcp = async (id: CliId) => {
    setMcp((s) => ({ ...s, [id]: { busy: true } }));
    const r = await postJson<McpResult>("/api/setup/ai/mcp", { id });
    const message = r?.failed.find((f) => f.id === id)?.message ?? r?.message ?? "it couldn't be reached.";
    setMcp((s) => ({ ...s, [id]: r?.ok ? { done: true } : { message } }));
    await refresh();
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
      talk={talk}
      results={results}
      phases={phases}
      mcp={mcp}
      onAction={(id, action) => (action === "signin" ? void signIn(id) : void connect(id))}
      onAdd={(id) => void addMcp(id)}
      onRefresh={() => void refresh()}
    />
  );
}
