import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { CliId, ConnectResult, LocalAiRow, LocalAiView, SignInResult } from "@contracts/local-ai";
import type { ProviderSettings, ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { getProviders, modelsOf, saveOwn, thisMacDevice } from "@/lib/providers";
import { startThisMac, thisMacBridge } from "@/lib/thisMac";

/** What Connect is doing now, one step at a time. */
export type Phase = "installing" | "updating" | "connecting" | "signingIn" | "timedOut";
export type Results = Partial<Record<CliId, ConnectResult>>;
export type Phases = Partial<Record<CliId, Phase>>;

const WAIT_MS = 3 * 60_000;
const POLL_MS = 3_000;
/** How often the list looks again by itself while it is on screen (each look runs the CLIs' status commands). */
const RECHECK_MS = 20_000;
/** How long a request may take before it gives up with a plain message (no wait spins forever). */
const TIMEOUT_MS = 90_000;
/** An install downloads the vendor's program here (ChatGPT's is 108 MB): a slow connection gets half an hour. */
const INSTALL_TIMEOUT_MS = 31 * 60_000;

/** The rows, in order: ChatGPT, then Claude; Gemini only once its tool is on this Mac (see AiPanelView). */
const AGENTS: CliId[] = ["codex", "claude", "gemini"];
/** What a person knows each AI by: the row's name, and its small second line. */
export const ROW_NAME: Record<CliId, string> = { codex: "ChatGPT", claude: "Claude", gemini: "Gemini" };
export const ROW_SUB: Record<CliId, string> = { codex: "Codex", claude: "Claude Code", gemini: "Google's coding helper" };
/** What Connect uses, said before the press: a free account isn't enough for ChatGPT or Claude (vendor docs, 2026-11-09). */
const USES: Record<CliId, string> = {
  codex: "Uses your ChatGPT plan (Plus or higher).",
  claude: "Uses your Claude plan (Pro or higher).",
  gemini: "Uses your Google account.",
};

const ROW = "flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3";

const isConnected = (row: LocalAiRow | undefined, result?: ConnectResult) => !!row?.connected || result?.state === "ready";

/** The app's own AI is connected: saved from before, or this session's Connect. */
export const anyConnected = (view: LocalAiView | null, results: Results): boolean =>
  AGENTS.some((id) => isConnected(view?.rows.find((r) => r.id === id), results[id]));

export interface RowView {
  /** one plain line: what Connect uses, what it is doing now, or what went wrong */
  line: string;
  /** the row's one button; none once connected */
  button: { label: string; disabled?: boolean } | null;
  connected?: boolean;
  raw?: string;
}

const WORKING = { label: "Connecting…", disabled: true };
const CONNECT = { label: "Connect" };

/**
 * What one AI's row says. One button, Connect, does whatever is still missing (install, update, sign in, connect), and
 * the line names the step it is on. The check mark only once it is connected, and then there is no button.
 */
export function rowView(id: CliId, row: LocalAiRow | undefined, result: ConnectResult | undefined, phase: Phase | undefined): RowView {
  const name = ROW_NAME[id];
  if (phase === "installing") return { line: `Installing what ${name} needs on this Mac. This can take a few minutes.`, button: WORKING };
  if (phase === "updating") return { line: `Updating what ${name} needs on this Mac. This can take a few minutes.`, button: WORKING };
  if (phase === "signingIn") return { line: "Finish signing in in your browser.", button: WORKING };
  if (phase === "connecting") return { line: USES[id], button: WORKING };
  if (phase === "timedOut") return { line: "Still not signed in. Finish in your browser, or connect again.", button: CONNECT };
  if (result?.state === "mac" || result?.state === "unsupported")
    return { line: result.message ?? "Open the Creator Toolset Mac app to connect this.", button: null };
  if (result && result.state !== "ready") return { line: result.message ?? "It didn't connect. Try again.", button: { label: "Try again" }, raw: result.raw };
  if (isConnected(row, result)) {
    // signed out since it was connected: Connect signs in again
    if (row?.signedIn === false && result?.state !== "ready") return { line: "Signed out since last time.", button: CONNECT };
    // a plan at its limit is connected; the line says when it resets
    return { line: result?.message ?? "", button: null, connected: true };
  }
  return { line: USES[id], button: CONNECT };
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

/** One AI's row: its logo, name and small second line, one plain line, and its one button. */
function AgentRow({ id, row, result, phase, onConnect }: { id: CliId; row?: LocalAiRow; result?: ConnectResult; phase?: Phase; onConnect: () => void }) {
  const v = rowView(id, row, result, phase);
  // Details only when something went wrong: the program's version and its own words
  const details = v.raw ? [row?.version, v.raw].filter(Boolean).join("\n") : "";
  return (
    <li className={ROW}>
      <ProviderLogo driver={id} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{ROW_NAME[id]}</p>
        <p className="text-xs text-muted-foreground">{ROW_SUB[id]}</p>
        {v.line && <p className="text-xs">{v.line}</p>}
        {details && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Details</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{details}</pre>
          </details>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {v.connected && <Check aria-label={`${ROW_NAME[id]} is connected`} className="size-4 text-emerald-600 dark:text-emerald-400" />}
        {v.button && (
          <Button size="sm" disabled={v.button.disabled} onClick={onConnect}>
            {v.button.label}
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
  onConnect: (id: CliId) => void;
}

/** The AIs this computer can connect: one row each (ChatGPT, Claude, and Gemini once installed). Pure, for tests. */
export function AiPanelView({ view, results, phases, onConnect }: AiPanelViewProps) {
  if (!view) return <p className="text-sm text-muted-foreground">Looking for your AI on this computer…</p>;
  if (!view.local)
    return <p className="text-sm text-muted-foreground">Ask the owner of this server to connect the AI it runs on.</p>;
  return (
    <ul className="space-y-2">
      {AGENTS.map((id) => {
        const row = view.rows.find((r) => r.id === id);
        if (id === "gemini" && !row?.found) return null;
        return <AgentRow key={id} id={id} row={row} result={results[id]} phase={phases[id]} onConnect={() => onConnect(id)} />;
      })}
    </ul>
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

const failed = (message: string, raw?: string): ConnectResult => ({ state: "failed", signedIn: null, answered: null, message, raw });

/** What Connect still has to do for one AI, from the server's answer and what this press already did. Pure, for tests. */
export function nextStep(state: ConnectResult["state"], did: { installed: boolean; updated: boolean; signedIn: boolean }): "install" | "update" | "signin" | "done" {
  if (state === "missing" && !did.installed) return "install";
  if (state === "outdated" && !did.updated) return "update";
  if (state === "signin" && !did.signedIn) return "signin";
  return "done";
}

/**
 * The AIs on this computer, with the server behind them. Connect is the one button: it installs the AI's program when
 * this Mac has none, updates one that is too old, opens the vendor's sign-in when it is signed out, and connects, each
 * step once per press. The list looks again by itself, never behind a button: when the window comes back to the front
 * and every RECHECK_MS while it is on screen.
 */
export function AiPanel({ onConnectedChange }: { onConnectedChange?: (on: boolean) => void }) {
  const [view, setView] = useState<LocalAiView | null>(null);
  const [results, setResults] = useState<Results>({});
  const [phases, setPhases] = useState<Phases>({});
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const timers = useRef<number[]>([]);

  // fresh: the server re-reads PATH and the sign-in; a plain read may answer from its last look.
  const refresh = useCallback(async (fresh = false) => {
    const v = await getJson<LocalAiView>(fresh ? "/api/setup/ai?fresh=1" : "/api/setup/ai");
    if (v) setView(v);
    return v;
  }, []);
  const loadProviders = useCallback(() => getProviders().then(setProviders, () => {}), []);

  const connect = useCallback(
    async (id: CliId, did = { installed: false, updated: false, signedIn: false }) => {
      const setPhase = (p: Phase | undefined) => setPhases((s) => ({ ...s, [id]: p }));
      const end = async (r: ConnectResult) => {
        setResults((s) => ({ ...s, [id]: r }));
        setPhase(undefined);
        await refresh(true);
        await loadProviders();
      };
      // the vendor's own installer runs on this computer; the row's line says so until it answers
      const install = async (phase: "installing" | "updating") => {
        setPhase(phase);
        const r = await postJson<SignInResult>("/api/setup/ai/install", { id }, INSTALL_TIMEOUT_MS);
        if (!r?.ok) await end(failed(r?.message ?? "Couldn't reach this computer. Try again.", r?.raw));
        return !!r?.ok;
      };
      setResults((s) => ({ ...s, [id]: undefined }));
      if (!did.installed && !(await refresh(true))?.rows.find((r) => r.id === id)?.found) {
        if (!(await install("installing"))) return;
        did = { ...did, installed: true };
      }
      for (;;) {
        setPhase("connecting");
        const device = await thisMacFor();
        const r = (await postJson<ConnectResult>("/api/setup/ai/connect", { id, device })) ?? failed("It took too long or couldn't be reached. Try again.");
        const step = nextStep(r.state, did);
        if (step === "install" || step === "update") {
          if (!(await install(step === "install" ? "installing" : "updating"))) return;
          did = step === "install" ? { ...did, installed: true } : { ...did, updated: true };
          continue;
        }
        if (step === "signin") {
          const started = await postJson<SignInResult>("/api/setup/ai/signin", { id });
          if (!started?.ok) return end(failed(started?.message ?? "Couldn't open the sign-in. Try again."));
          // the vendor's sign-in is open in the browser: look every few seconds, then connect
          setPhase("signingIn");
          const since = Date.now();
          const next = { ...did, signedIn: true };
          const t = window.setInterval(async () => {
            const v = await refresh(true);
            if (v?.rows.find((x) => x.id === id)?.signedIn) {
              window.clearInterval(t);
              void connect(id, next);
            } else if (Date.now() - since > WAIT_MS) {
              window.clearInterval(t);
              setPhase("timedOut");
            }
          }, POLL_MS);
          timers.current.push(t);
          return;
        }
        // a step that was already done this press and is asked for again is a failure, said plainly
        return end(r.state === "signin" ? failed("The sign-in didn't finish. Try again.", r.raw) : r.state === "missing" ? failed(r.message ?? "It didn't install. Try again.", r.raw) : r);
      }
    },
    [refresh, loadProviders],
  );

  useEffect(() => {
    void refresh();
    void loadProviders();
    const list = timers.current;
    return () => list.forEach((t) => window.clearInterval(t));
  }, [refresh, loadProviders]);

  // looks again by itself: the window back in front (a sign-in finished elsewhere), and a slow timer while visible
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", again);
    const t = window.setInterval(again, RECHECK_MS);
    return () => {
      window.removeEventListener("focus", again);
      window.clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    onConnectedChange?.(anyConnected(view, results));
  }, [view, results, onConnectedChange]);

  return (
    <div className="space-y-3">
      {/* a choice only when there is one: two AIs connected */}
      {providers && (providers.own?.instances.filter((i) => i.enabled).length ?? 0) > 1 && (
        <AnswerPicker view={providers} onPick={(s) => void saveOwn(s).then(setProviders, () => {})} />
      )}
      <AiPanelView view={view} results={results} phases={phases} onConnect={(id) => void connect(id)} />
    </div>
  );
}
