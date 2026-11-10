import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { INSTALL_LINE, type CliId, type ConnectResult, type LocalAiId, type LocalAiRow, type LocalAiView, type SignInResult } from "@contracts/local-ai";
import type { ProviderSettings, ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { getProviders, modelsOf, saveOwn, thisMacDevice } from "@/lib/providers";
import { startThisMac, thisMacBridge } from "@/lib/thisMac";

export type Phase = "connecting" | "signingIn" | "timedOut";
export type Results = Partial<Record<LocalAiId, ConnectResult>>;
export type Phases = Partial<Record<LocalAiId, Phase>>;
type Action = "connect" | "signin" | "check";

const WAIT_MS = 3 * 60_000;
const POLL_MS = 3_000;
/** How long a request may take before it gives up with a plain message (no wait spins forever). */
const TIMEOUT_MS = 90_000;
/** An install runs the vendor's installer here: a few minutes on a slow connection. */
const INSTALL_TIMEOUT_MS = 6 * 60_000;

/** The rows, in order: ChatGPT, then Claude; Gemini only once its tool is on this Mac (see AiPanelView). */
const AGENTS: CliId[] = ["codex", "claude", "gemini"];
/** What a person knows each AI by: the row's name, and its small second line. */
export const ROW_NAME: Record<CliId, string> = { codex: "ChatGPT", claude: "Claude", gemini: "Gemini" };
export const ROW_SUB: Record<CliId, string> = { codex: "Codex", claude: "Claude Code", gemini: "Google's coding helper" };
/** The account that signs each AI in, in the words a person uses. */
const ACCOUNT: Record<CliId, string> = { codex: "ChatGPT", claude: "Claude", gemini: "Google" };
/** What an install puts on this Mac. */
const HELPER: Record<CliId, string> = { codex: "ChatGPT's coding helper", claude: "Claude Code", gemini: "Google's coding helper" };
const DESKTOP_NAME: Partial<Record<LocalAiId, string>> = { "claude-desktop": "Claude app", "chatgpt-desktop": "ChatGPT app" };
/** The plan each needs: ChatGPT's coding helper first comes with Plus, Claude Code isn't in the free Claude plan. */
const PLAN: Partial<Record<CliId, string>> = { codex: "ChatGPT Plus", claude: "Claude Pro" };
/**
 * What a desktop app can honestly do from here. The ChatGPT app shares Codex's settings, so it gets Creator Toolset
 * when ChatGPT above adds it. The Claude app needs its own extension file, not built yet.
 */
const DESKTOP_LINE: Partial<Record<LocalAiId, string>> = {
  "chatgpt-desktop": "Gets Creator Toolset when ChatGPT above is set up. Restart the app after.",
  "claude-desktop": "Can't be set up from here yet. Use Claude above.",
};

const ROW = "flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3";

const isCli = (id: LocalAiId): id is CliId => id === "claude" || id === "codex" || id === "gemini";
const plain = (msg: string) => msg.replace(/\.+$/, "");
const isConnected = (row: LocalAiRow, result?: ConnectResult) => row.connected || result?.state === "ready";

/** The app's own AI has a passing check: saved from before, or this session's Connect. */
export const anyConnected = (view: LocalAiView | null, results: Results): boolean =>
  !!view?.rows.some((r) => isCli(r.id) && isConnected(r, results[r.id]));

/** A row's one button. "use" makes this AI the one that answers in the app; "install" runs its installer. */
export interface RowButton {
  label: string;
  action: Action | "install" | "use" | "none";
  disabled?: boolean;
}

export interface RowView {
  line: string;
  button: RowButton | null;
  connected?: boolean;
  raw?: string;
}

/**
 * What one AI's row says, checked in order: an in-progress step first, then this session's last press, then the probe.
 * The check mark only after a passing check, so a failed part never shows it.
 */
export function rowView(row: LocalAiRow, result: ConnectResult | undefined, phase: Phase | undefined, usedByApp = false): RowView {
  const id = row.id as CliId;
  const connected = isConnected(row, result);
  const signed = row.signedIn ?? (result?.state === "ready" ? true : null);
  // a free account isn't enough for either (vendor docs, 2026-11-09): say so before the person tries
  const signIn: RowView = { line: `Sign in with your ${ACCOUNT[id]} account.${PLAN[id] ? ` Needs ${PLAN[id]} or higher.` : ""}`, button: { label: "Sign in", action: "signin" } };
  if (phase === "connecting") return { line: "Checking. This can take up to a minute.", button: { label: "Checking…", action: "connect", disabled: true } };
  if (phase === "signingIn")
    return { line: "Waiting for you to finish in your browser. This page checks by itself.", button: { label: "Waiting…", action: "none", disabled: true } };
  if (phase === "timedOut")
    return { line: "Still not signed in. Finish in your browser, then press Check again.", button: { label: "Check again", action: "check" } };
  if (result?.state === "failed")
    return { line: `It didn't answer: ${plain(result.message ?? "Try again")}.`, button: { label: "Try again", action: "connect" }, raw: result.raw };
  if (result?.state === "mac" || result?.state === "unsupported")
    return { line: result.message ?? "Open the Creator Toolset Mac app to use this.", button: { label: "Use it", action: "none", disabled: true } };
  if (result?.state === "signin") return signIn;
  if (connected && signed === false)
    return { line: `Signed out since last time. Sign in with your ${ACCOUNT[id]} account again.`, button: { label: "Sign in", action: "signin" } };
  if (connected)
    return usedByApp
      ? { line: "This is the AI that answers in the app.", button: { label: "In use", action: "none", disabled: true }, connected: true }
      : { line: "Makes this the AI that answers in the app.", button: { label: "Use it", action: "use" }, connected: true };
  if (signed === false) return signIn;
  return { line: "Checks it works, then lets Creator Toolset use it.", button: { label: "Use it", action: "connect" } };
}

/** The AnswerPicker: which AI answers in the app and with which model (the default of the account's providers, as Settings → Your AI sets it). Only the AIs this account has connected are offered. Pure: `onPick` gets the whole new set to save. */
export function AnswerPicker({ view, onPick }: { view: ProvidersView; onPick: (s: ProviderSettings) => void }) {
  const own = view.own;
  const options = own?.instances.filter((i) => i.enabled) ?? [];
  if (!own || !options.length) return null;
  const cur = own.default;
  const current = options.find((i) => i.id === cur.instance);
  const models = current ? modelsOf(view, current) : [];
  const pick = (instance: string, model: string) => onPick({ ...own, default: { instance, model, effort: cur.effort } });
  const pickAi = (id: string) => {
    const inst = options.find((i) => i.id === id);
    if (inst) pick(inst.id, modelsOf(view, inst)[0] ?? cur.model);
  };
  const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">Answers in the app</span>
      <select aria-label="AI that answers in the app" className={selectCls} value={current ? cur.instance : ""} onChange={(e) => pickAi(e.target.value)}>
        {!current && <option value="">Pick one</option>}
        {options.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      {current && (
        <select aria-label="Model" className={selectCls} value={cur.model} onChange={(e) => pick(cur.instance, e.target.value)}>
          {(models.includes(cur.model) ? models : [cur.model, ...models]).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** A failed install or save: one plain sentence, the command's output for Details, and the install line for Copy. */
export interface InstallMsg {
  message: string;
  raw?: string;
  line?: string;
}

/** One AI's row: its logo, name and small second line, one plain line saying what its one button does, and that button. */
function AgentRow({
  id,
  row,
  result,
  phase,
  installing,
  installDisabled,
  usedByApp,
  onAction,
  onInstall,
  onUseForApp,
}: {
  id: CliId;
  row?: LocalAiRow;
  result?: ConnectResult;
  phase?: Phase;
  /** this AI's install is running */
  installing: boolean;
  /** some install is running (this row's Install waits for it) */
  installDisabled: boolean;
  /** this AI is the one that answers in the app (its default) */
  usedByApp: boolean;
  onAction: (a: Action) => void;
  onInstall?: (id: CliId) => void;
  onUseForApp?: (id: CliId) => void;
}) {
  const found = !!row?.found;
  const v = found && row ? rowView(row, result, phase, usedByApp) : null;
  const line = !found
    ? installing
      ? `Installing ${HELPER[id]}. This can take a few minutes.`
      : `Install ${HELPER[id]} on this Mac, then sign in with your ${ACCOUNT[id]} account.`
    : v?.line ?? "";
  const button: RowButton | null = !found
    ? installing
      ? { label: "Installing…", action: "none", disabled: true }
      : { label: "Install", action: "install", disabled: installDisabled }
    : v?.button ?? null;
  const press = (a: RowButton["action"]) => {
    if (a === "none") return;
    if (a === "install") onInstall?.(id);
    else if (a === "use") onUseForApp?.(id);
    else onAction(a);
  };
  const details = [row?.version, v?.raw].filter(Boolean).join("\n");
  return (
    <li className={ROW}>
      <ProviderLogo driver={id} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{ROW_NAME[id]}</p>
        <p className="text-xs text-muted-foreground">{ROW_SUB[id]}</p>
        {line && <p className="text-xs">{line}</p>}
        {details && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Details</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{details}</pre>
          </details>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {v?.connected && <Check aria-label={`${ROW_NAME[id]} is connected`} className="size-4 text-emerald-600 dark:text-emerald-400" />}
        {button && (
          <Button
            size="sm"
            variant={button.action === "use" || button.action === "none" ? "outline" : "default"}
            disabled={button.disabled}
            onClick={() => press(button.action)}
          >
            {button.label}
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
  /** the AI being installed now */
  installing?: CliId | null;
  installMsg?: InstallMsg | null;
  /** the instance id that answers in the app ("local-claude"…), so its row says so */
  appAi?: string;
  onAction: (id: CliId, action: Action) => void;
  onInstall?: (id: CliId) => void;
  onUseForApp?: (id: CliId) => void;
  onRefresh: () => void;
}

/** The AIs on this computer: one row each (ChatGPT, Claude, Gemini once installed), and the desktop apps installed. Pure, for tests. */
export function AiPanelView({ view, results, phases, installing = null, installMsg, appAi, onAction, onInstall, onUseForApp, onRefresh }: AiPanelViewProps) {
  if (!view) return <p className="text-sm text-muted-foreground">Looking for your AI on this computer…</p>;
  if (!view.local)
    return <p className="text-sm text-muted-foreground">Ask the owner of this server to connect the AI it runs on.</p>;
  // the server lists a desktop app only when it is installed
  const desktops = view.rows.filter((r) => r.kind === "desktop");
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {AGENTS.map((id) => {
          const row = view.rows.find((r) => r.id === id);
          if (id === "gemini" && !row?.found) return null;
          return (
            <AgentRow
              key={id}
              id={id}
              row={row}
              result={results[id]}
              phase={phases[id]}
              installing={installing === id}
              installDisabled={installing !== null}
              usedByApp={appAi === `local-${id}`}
              onAction={(a) => onAction(id, a)}
              onInstall={onInstall}
              onUseForApp={onUseForApp}
            />
          );
        })}
        {desktops.map((r) => (
          <li key={r.id} className={ROW}>
            <ProviderLogo driver={r.id.startsWith("claude") ? "claude" : "codex"} className="mt-0.5 size-5" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">{DESKTOP_NAME[r.id] ?? r.name}</p>
              {/* ponytail: the Claude app's one-click action = a generated .mcpb with a small stdio bridge (port + key in its env); build it when wanted */}
              <p className="text-xs">{DESKTOP_LINE[r.id] ?? "Installed on this Mac."}</p>
            </div>
          </li>
        ))}
      </ul>
      {installMsg && (
        <div role="status" className="space-y-1 text-xs">
          <p>{installMsg.message}</p>
          {(installMsg.raw || installMsg.line) && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Details</summary>
              {installMsg.raw && <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{installMsg.raw}</pre>}
              {installMsg.line && (
                <Button size="sm" variant="outline" className="mt-1" onClick={() => void navigator.clipboard?.writeText(installMsg.line ?? "").catch(() => {})}>
                  Copy install command
                </Button>
              )}
            </details>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          Check again
        </Button>
      </div>
    </div>
  );
}

/**
 * This Mac's device on this server. In the Mac app, Connect first turns this Mac's AI on and pairs it (the app does both
 * and answers with the device); in a browser there is no Mac to pair, so the page's own device id is used.
 */
async function thisMacFor(): Promise<string | undefined> {
  if (!thisMacBridge()) return thisMacDevice();
  const state = await startThisMac();
  return state?.device ?? thisMacDevice();
}

/** One request, bounded: no answer in time (or no server) is null, which the caller turns into a plain message. */
async function request<T>(url: string, init?: RequestInit, ms = TIMEOUT_MS): Promise<T | null> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), ms);
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
const postJson = <T,>(url: string, body: unknown, ms?: number) =>
  request<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, ms);

/**
 * The AIs on this computer, with the server behind them: reads what the computer has, and runs Connect, Sign in and
 * Install only when the person presses them. "Check again" re-reads the computer (no cached answer). After Sign in it
 * checks by itself every few seconds for up to three minutes.
 */
export function AiPanel({ onConnectedChange }: { onConnectedChange?: (on: boolean) => void }) {
  const [view, setView] = useState<LocalAiView | null>(null);
  const [results, setResults] = useState<Results>({});
  const [phases, setPhases] = useState<Phases>({});
  const [installing, setInstalling] = useState<CliId | null>(null);
  const [installMsg, setInstallMsg] = useState<InstallMsg | null>(null);
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const timers = useRef<number[]>([]);

  // fresh: Check again. The server re-reads PATH and the sign-in; a plain read may answer from its last look.
  const refresh = useCallback(async (fresh = false) => {
    const v = await getJson<LocalAiView>(fresh ? "/api/setup/ai?fresh=1" : "/api/setup/ai");
    if (v) setView(v);
    return v;
  }, []);
  const loadProviders = useCallback(() => getProviders().then(setProviders, () => {}), []);
  const setPhase = (id: LocalAiId, p: Phase | undefined) => setPhases((s) => ({ ...s, [id]: p }));

  const connect = useCallback(
    async (id: CliId) => {
      setPhase(id, "connecting");
      const device = await thisMacFor();
      const r = await postJson<ConnectResult>("/api/setup/ai/connect", { id, device });
      setResults((s) => ({ ...s, [id]: r ?? { state: "failed", signedIn: null, answered: null, message: "it took too long or couldn't be reached, so try again" } }));
      setPhase(id, undefined);
      await refresh(true);
      await loadProviders();
    },
    [refresh, loadProviders],
  );

  /** Saves the account's providers with a new default (the picker, or "Use it"); a failed save says so. */
  const pickDefault = (s: ProviderSettings) => saveOwn(s).then(setProviders, () => setInstallMsg({ message: "Couldn't save that. Try again." }));
  const useForApp = (id: CliId) => {
    const own = providers?.own;
    const inst = own?.instances.find((i) => i.id === `local-${id}`);
    if (!own || !providers || !inst) return;
    void pickDefault({ ...own, default: { instance: inst.id, model: modelsOf(providers, inst)[0] ?? own.default.model, effort: own.default.effort } });
  };

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

  // the vendor's own installer runs on this computer; the row shows the progress line until it answers
  const install = async (id: CliId) => {
    setInstalling(id);
    setInstallMsg(null);
    const r = await postJson<SignInResult>("/api/setup/ai/install", { id }, INSTALL_TIMEOUT_MS);
    setInstalling(null);
    if (r?.ok) {
      await refresh(true);
      return;
    }
    setInstallMsg({ message: r?.message ?? "Couldn't reach this computer. Try again.", raw: r?.raw, line: INSTALL_LINE[id] });
  };

  useEffect(() => {
    void refresh();
    void loadProviders();
    const list = timers.current;
    return () => list.forEach((t) => window.clearInterval(t));
  }, [refresh, loadProviders]);

  useEffect(() => {
    onConnectedChange?.(anyConnected(view, results));
  }, [view, results, onConnectedChange]);

  return (
    <div className="space-y-3">
      {providers && <AnswerPicker view={providers} onPick={(s) => void pickDefault(s)} />}
      <AiPanelView
        view={view}
        results={results}
        phases={phases}
        installing={installing}
        installMsg={installMsg}
        appAi={providers?.own?.default.instance}
        onAction={(id, action) => (action === "signin" ? void signIn(id) : void connect(id))}
        onInstall={(id) => void install(id)}
        onUseForApp={useForApp}
        onRefresh={() => void refresh(true)}
      />
    </div>
  );
}
