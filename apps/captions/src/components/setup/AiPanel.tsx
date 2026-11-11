import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, Loader2, LogIn } from "lucide-react";
import type { ConnectResult, LocalAiView, SignInResult } from "@contracts/local-ai";
import { PLANS, type PlanId } from "@contracts/plans";
import { DRIVERS, type ProviderSettings, type ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { Card, ListRow, Status } from "@/components/settings/ui";
import { useAuth } from "@/lib/auth";
import { putCached, readCached } from "@/lib/local-cache";
import { getProviders, modelsOf, saveOwn, thisMacDevice } from "@/lib/providers";
import { startThisMac, thisMacBridge } from "@/lib/thisMac";
import { cn } from "@/lib/utils";

/** What a row's button is doing now, one step at a time. */
export type Phase = "installing" | "updating" | "connecting" | "signingIn" | "timedOut";
/** Keyed by the AI's id: ChatGPT, Claude and Google by their CLI's (CliId), the others by their driver's. */
export type Results = Partial<Record<string, ConnectResult>>;
export type Phases = Partial<Record<string, Phase>>;

const WAIT_MS = 3 * 60_000;
const POLL_MS = 3_000;
/** How often the list looks again by itself while it is on screen (each look runs the CLIs' status commands). */
const RECHECK_MS = 20_000;
/** Away from the window this long, an account turned away (no plan) may have bought one: its row offers Connect again. */
const AWAY_MS = 30_000;
/** How long a request may take before it gives up with a plain message (no wait spins forever). */
const TIMEOUT_MS = 90_000;
/** An install downloads the vendor's program here (Meta's is about 470 MB): a slow connection gets an hour. */
const INSTALL_TIMEOUT_MS = 61 * 60_000;
/** The saved copies this screen opens with, under the addresses Settings keeps them (AiSetup's useLocalAi, useProviders). */
const LOCAL_AI = "/api/setup/ai";
const PROVIDERS = "/api/providers";

/**
 * The AIs this screen sets up, in order: what a person knows each by, the program's name small beside it, and what it
 * runs on. Each one installs, signs in and connects from its one button. `more` puts it behind Show more, where any other
 * AI the Mac app runs that is already on this Mac (LocalAiView.others) is listed too, which the button only connects.
 * Plans: a free account isn't enough for ChatGPT or Claude (vendor docs, 2026-11-09), nor for Google: its quotas page
 * lists free, Google AI Pro and Ultra, but a real run on a free account was turned away (2026-11-10; contracts/plans.ts
 * noPlanLine), and no run of ours was on a paid one; Grok's and Cursor's sign-ins take
 * the person's account, whose plans their vendors don't list for these programs; Muse Code has no free tier (Everyday,
 * High, Power and Maximum Usage plans). `size`: what its install downloads, said while it runs (measured 2026-11-10).
 */
export const AIS: Array<{ id: string; name: string; sub: string; uses: string; size?: string; more?: boolean }> = [
  { id: "codex", name: "ChatGPT", sub: "Codex", uses: "Uses your ChatGPT plan (Plus or higher).", size: "about 110 MB" },
  { id: "claude", name: "Claude", sub: "Claude Code", uses: "Uses your Claude plan (Pro or higher)." },
  { id: "gemini", name: "Google", sub: "Gemini", uses: "Uses your Google AI plan (Pro or Ultra)." },
  { id: "grok", name: "Grok", sub: "Grok Build", uses: "Uses your Grok account.", size: "about 185 MB" },
  { id: "musecode", name: "Meta", sub: "Muse Code", uses: "Uses your Meta plan (Everyday or higher).", size: "about 470 MB" },
  { id: "cursor", name: "Cursor", sub: "Cursor Agent", uses: "Uses your Cursor account.", size: "about 175 MB", more: true },
];
const aiOf = (id: string) => AIS.find((a) => a.id === id);
/** What a person knows each AI by, and its small second line (setup's other screens name them the same way). */
export const ROW_NAME: Record<string, string> = Object.fromEntries(AIS.map((a) => [a.id, a.name]));
export const ROW_SUB: Record<string, string> = Object.fromEntries(AIS.map((a) => [a.id, a.sub]));
const nameOf = (id: string) => aiOf(id)?.name ?? DRIVERS.find((d) => d.id === id)?.label ?? id;
const usesOf = (id: string) => aiOf(id)?.uses ?? `Uses ${nameOf(id)} as it's set up on this Mac.`;

/**
 * What a row knows of its AI: found on this Mac, signed in (when that can be read), connected (a saved passing check),
 * and the plan its own tools name (api/lib/local-ai.ts knownPlans).
 */
type Known = { found?: boolean; connected: boolean; signedIn?: boolean | null; version?: string; plan?: PlanId };
const isConnected = (row: Known | undefined, result?: ConnectResult) => !!row?.connected || result?.state === "ready";
const rowOf = (view: LocalAiView | null, id: string): Known | undefined => view?.rows.find((r) => r.id === id) ?? view?.others?.find((o) => o.id === id);
/** Every AI on the screen: the ones above, then the other AIs found on this Mac. */
const idsOf = (view: LocalAiView | null) => [...AIS.map((a) => a.id), ...(view?.others ?? []).filter((o) => !aiOf(o.id) && o.found).map((o) => o.id)];

/** The app's own AI is connected: saved from before, or this session's Connect, on any row. */
export const anyConnected = (view: LocalAiView | null, results: Results): boolean => idsOf(view).some((id) => isConnected(rowOf(view, id), results[id]));

export interface RowView {
  /** one plain line: what it is, what it is doing now, or what went wrong */
  line: string;
  /** the row's one button, named for what it does next; none once connected */
  button: { label: string; disabled?: boolean } | null;
  connected?: boolean;
  raw?: string;
}

const working = (label: string) => ({ label, disabled: true });
const INSTALL = { label: "Install" };
const SIGN_IN = { label: "Sign in" };
const CONNECT = { label: "Connect" };

/**
 * A program's own words without the instructions in them to run something: a `command`, a line to type, "run: …", a
 * sentence that leads into one. What it said shows the rest; the row itself says the plain thing. A command line is
 * typed in small letters: "Claude on the Mac: …", the way every Claude error starts, is the program's words, not one.
 */
const COMMAND = /`|\b(run|type|paste)\b|environment variable|:\s*$/i;
const COMMAND_LINE = /^\s*(\$|export|source|sudo|curl|npm|npx|brew|echo|mkdir|grok|agent|cursor-agent|codex|claude|gemini|muse)(\s|$)/;
/** A file's path in the words ("/Users/x/.grok/bin/grok", "~/.zshrc"): shown as "…", never the file itself. */
const FILE_PATH = /(^|[\s'"(=])(?:~|\/)[\w.@-]*(?:\/[\w.@-]+)+\/?/g;
export const withoutCommands = (raw?: string): string | undefined =>
  raw
    ?.split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !COMMAND.test(s) && !COMMAND_LINE.test(s)).join(" ").replace(FILE_PATH, "$1…"))
    .filter((line) => line.trim())
    .join("\n") || undefined;

/**
 * What one AI's row says. Before any press its state: not on this Mac (Install), signed out (Sign in), or ready
 * (Connect). One press does everything still missing, and the button names the step it is on. Not signed in is never a
 * failure: a check that says so offers Sign in. The check mark only once it is connected, and then there is no button.
 */
export function rowView(id: string, row: Known | undefined, result: ConnectResult | undefined, phase: Phase | undefined, code?: string): RowView {
  const name = nameOf(id);
  const ours = !!aiOf(id); // installs and signs in from here
  const size = aiOf(id)?.size;
  if (phase === "installing") return { line: `Installing what ${name} needs on this Mac${size ? ` (${size})` : ""}. This can take a few minutes.`, button: working("Installing…") };
  if (phase === "updating") return { line: `Updating what ${name} needs on this Mac. This can take a few minutes.`, button: working("Updating…") };
  // a sign-in that asks for a code on the vendor's page (Meta's): the code is the line
  if (phase === "signingIn") return { line: code ? `Confirm this code on Meta's page: ${code}` : "Finish signing in in your browser.", button: working("Signing in…") };
  if (phase === "connecting") return { line: usesOf(id), button: working("Connecting…") };
  if (phase === "timedOut") return { line: "Still not signed in. Finish in your browser, or sign in again.", button: SIGN_IN };
  if (result?.state === "mac" || result?.state === "unsupported")
    return { line: result.message ?? "Open the Creator Toolset Mac app to connect this.", button: null };
  if (result?.state === "signin")
    return ours ? { line: `Not signed in yet. ${usesOf(id)}`, button: SIGN_IN } : { line: `Not signed in to ${name} on this Mac yet.`, button: CONNECT };
  // the account has no plan for this AI: the line says what it needs, and no Try again (coming back to the window after
  // a while clears it, so a plan bought meanwhile connects from the row's Connect)
  if (result?.state === "plan") return { line: result.message ?? "", button: null, raw: withoutCommands(result.raw) };
  if (result && result.state !== "ready") return { line: result.message ?? "It didn't connect. Try again.", button: { label: "Try again" }, raw: withoutCommands(result.raw) };
  if (isConnected(row, result)) {
    // signed out since it was connected: the button signs in again
    if (row?.signedIn === false && result?.state !== "ready") return { line: "Signed out since last time.", button: ours ? SIGN_IN : CONNECT };
    // a plan at its limit is connected; the line says when it resets. Else the plan, when the AI names it
    const plan = PLANS.find((p) => p.id === row?.plan)?.label;
    return { line: result?.message ?? (plan ? `${plan} plan` : ""), button: null, connected: true };
  }
  if (ours && !row?.found) return { line: `Not on this Mac yet. ${usesOf(id)}`, button: INSTALL };
  if (ours && row?.signedIn === false) return { line: `Not signed in yet. ${usesOf(id)}`, button: SIGN_IN };
  return { line: usesOf(id), button: CONNECT };
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

/**
 * One AI's row, in the same rows as Settings and setup's last screen: its logo, its name with the program's name small
 * beside it, one plain line, and its one button. A failure is the red line, an account with no plan for it the amber one,
 * each with the program's own words under What it said.
 */
function AgentRow({ id, row, result, phase, code, unread, onConnect }: { id: string; row?: Known; result?: ConnectResult; phase?: Phase; code?: string; unread?: boolean; onConnect: () => void }) {
  // not read yet: the row says what it uses and claims nothing about this Mac; its state and button follow the answer
  const v: RowView = unread ? { line: usesOf(id), button: null } : rowView(id, row, result, phase, code);
  const failed = !phase && !!result && !["ready", "mac", "unsupported", "signin"].includes(result.state);
  const noPlan = result?.state === "plan";
  return (
    <ListRow
      icon={<ProviderLogo driver={id} className="size-4" />}
      title={
        <>
          <span>{nameOf(id)}</span>{" "}
          {aiOf(id) && <span className="ml-0.5 text-xs font-normal text-muted-foreground">{ROW_SUB[id]}</span>}
        </>
      }
      subtitle={failed ? undefined : v.line || undefined}
      status={
        failed ? (
          <>
            <Status tone={noPlan ? "attention" : "broken"}>{v.line}</Status>
            {/* only when something went wrong: the program's version and its own words */}
            {v.raw && (
              <details className="pt-0.5">
                <summary className="cursor-pointer">What it said</summary>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{[row?.version, v.raw].filter(Boolean).join("\n")}</pre>
              </details>
            )}
          </>
        ) : undefined
      }
      actions={
        <>
          {v.connected && <Check aria-label={`${nameOf(id)} is connected`} className="size-4 text-emerald-600 dark:text-emerald-400" />}
          {v.button && (
            // Connect is the one filled button: one press from working. A step that downloads or opens the browser is
            // outlined and carries its sign; a button at work turns its sign into a spinner
            <Button size="xs" variant={v.button.label.startsWith(CONNECT.label) ? "default" : "outline"} disabled={v.button.disabled} onClick={onConnect}>
              {v.button.disabled ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : v.button.label === INSTALL.label ? (
                <Download aria-hidden className="size-3" />
              ) : v.button.label === SIGN_IN.label ? (
                <LogIn aria-hidden className="size-3" />
              ) : null}
              {v.button.label}
            </Button>
          )}
        </>
      }
    />
  );
}

export interface AiPanelViewProps {
  view: LocalAiView | null;
  results: Results;
  phases: Phases;
  /** the code a sign-in asks the person to confirm on the vendor's page, by AI */
  codes?: Partial<Record<string, string>>;
  onConnect: (id: string) => void;
  showMore?: boolean;
  onShowMore?: () => void;
  /** this account's own computer runs the server (not hosted, an admin): the server will answer with rows */
  own?: boolean;
}

/**
 * The AIs this computer can connect: ChatGPT, Claude, Google and Grok up front, the rest behind Show more. One that is
 * connected, working or failed is always up front. Pure, for tests.
 */
export function AiPanelView({ view, results, phases, codes = {}, onConnect, showMore = false, onShowMore, own = true }: AiPanelViewProps) {
  // Before the first answer (a first open; later the saved copy is there) nothing stands in for the list: the rows are
  // up at once, each with what it uses, and an account the server connects no AI for has its line at once.
  if (view ? !view.local : !own)
    return <p className="text-sm text-muted-foreground">Ask the owner of this server to connect the AI it runs on.</p>;
  const behind = (id: string) => (!aiOf(id) || !!aiOf(id)?.more) && !phases[id] && !results[id] && !isConnected(rowOf(view, id));
  const ids = idsOf(view);
  const hidden = ids.some(behind);
  const row = (id: string) => <AgentRow key={id} id={id} row={rowOf(view, id)} result={results[id]} phase={phases[id]} code={codes[id]} unread={!view} onConnect={() => onConnect(id)} />;
  return (
    <div className="space-y-2">
      <Card>{ids.filter((id) => showMore || !behind(id)).map(row)}</Card>
      {hidden && (
        <button type="button" aria-expanded={showMore} onClick={onShowMore} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          {showMore ? "Show less" : "Show more"}
          <ChevronDown className={cn("size-3.5 transition-transform", showMore && "rotate-180")} />
        </button>
      )}
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

const failed = (message: string, raw?: string): ConnectResult => ({ state: "failed", signedIn: null, answered: null, message, raw });

/** What Connect still has to do for one AI, from the server's answer and what this press already did. Pure, for tests. */
export function nextStep(state: ConnectResult["state"], did: { installed: boolean; updated: boolean; signedIn: boolean }): "install" | "update" | "signin" | "done" {
  if (state === "missing" && !did.installed) return "install";
  if (state === "outdated" && !did.updated) return "update";
  if (state === "signin" && !did.signedIn) return "signin";
  return "done";
}

/**
 * The AIs on this computer, with the server behind them. Each row's one button does what is still missing, each step once
 * per press: it installs the AI's program when this Mac has none, updates one that is too old, opens the vendor's sign-in
 * when it is signed out, and connects. The list looks again by itself, never behind a button: when the window comes back
 * to the front and every RECHECK_MS while it is on screen.
 */
export function AiPanel({ onConnectedChange }: { onConnectedChange?: (on: boolean) => void }) {
  const user = useAuth((s) => s.me?.username ?? null);
  // what the server decides the rows by (api/setup.ts ownComputer), known here before it answers
  const own = useAuth((s) => !s.hosted && s.me?.role === "admin");
  // the list and the answering AI open with what they showed last (the same saved copies Settings reads)
  const [view, setView] = useState<LocalAiView | null>(() => readCached<LocalAiView>(user, LOCAL_AI));
  const [results, setResults] = useState<Results>({});
  const [phases, setPhases] = useState<Phases>({});
  const [providers, setProviders] = useState<ProvidersView | null>(() => readCached<ProvidersView>(user, PROVIDERS));
  const [showMore, setShowMore] = useState(false);
  const [codes, setCodes] = useState<Partial<Record<string, string>>>({});
  const timers = useRef<number[]>([]);

  // fresh: the server re-reads PATH and the sign-in; a plain read may answer from its last look.
  const refresh = useCallback(async (fresh = false) => {
    const v = await getJson<LocalAiView>(fresh ? `${LOCAL_AI}?fresh=1` : LOCAL_AI);
    if (v) {
      setView(v);
      putCached(user, LOCAL_AI, v);
    }
    return v;
  }, [user]);
  const loadProviders = useCallback(
    () =>
      getProviders().then(
        (p) => {
          setProviders(p);
          putCached(user, PROVIDERS, p);
        },
        () => {},
      ),
    [user],
  );

  const connect = useCallback(
    // another AI on this Mac is connected as it is: nothing to install, update or sign in from here
    async (id: string, did = aiOf(id) ? { installed: false, updated: false, signedIn: false } : { installed: true, updated: true, signedIn: true }) => {
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
      // the vendor's own sign-in opens in the browser: the row looks every few seconds, then connects by itself
      const signIn = async () => {
        setPhase("signingIn");
        const started = await postJson<SignInResult>("/api/setup/ai/signin", { id });
        if (!started?.ok) return end(failed(started?.message ?? "Couldn't open the sign-in. Try again."));
        setCodes((s) => ({ ...s, [id]: started.code }));
        const since = Date.now();
        const next = { ...did, signedIn: true };
        const t = window.setInterval(async () => {
          const v = await refresh(true);
          if (rowOf(v, id)?.signedIn) {
            window.clearInterval(t);
            void connect(id, next);
          } else if (Date.now() - since > WAIT_MS) {
            window.clearInterval(t);
            // Grok's, Meta's and Cursor's sign-in is read from a file: when the wait runs out the real check has the last word
            if (v?.others?.some((o) => o.id === id)) void connect(id, next);
            else setPhase("timedOut");
          }
        }, POLL_MS);
        timers.current.push(t);
      };
      setResults((s) => ({ ...s, [id]: undefined }));
      let now = await refresh(true);
      if (!did.installed && !rowOf(now, id)?.found) {
        if (!(await install("installing"))) return;
        did = { ...did, installed: true };
        now = await refresh(true);
      }
      // signed out, as the program says before any check: straight to its sign-in
      if (!did.signedIn && rowOf(now, id)?.signedIn === false) return signIn();
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
        if (step === "signin") return signIn();
        // signed out before any sign-in is the row's state (Sign in), never a failure. Still signed out after this press's
        // own sign-in is one: said plainly, with the program's words under Details
        if (r.state === "signin" && aiOf(id)) return end(failed("The sign-in didn't finish. Try again.", r.raw));
        return end(r.state === "missing" ? failed(r.message ?? "It didn't install. Try again.", r.raw) : r);
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
    // back in front after a while elsewhere, an account turned away may have its plan now: its row offers Connect again.
    // Only after a while: a web view can take focus just after the press, which would wipe the sentence unread
    let away = 0;
    const leave = () => (away = Date.now());
    const front = () => {
      if (away && Date.now() - away >= AWAY_MS)
        setResults((s) => (Object.values(s).some((r) => r?.state === "plan") ? Object.fromEntries(Object.entries(s).filter(([, r]) => r?.state !== "plan")) : s));
      away = 0;
      again();
    };
    window.addEventListener("blur", leave);
    window.addEventListener("focus", front);
    const t = window.setInterval(again, RECHECK_MS);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", front);
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
      <AiPanelView view={view} results={results} phases={phases} codes={codes} onConnect={(id) => void connect(id)} showMore={showMore} onShowMore={() => setShowMore((o) => !o)} own={own} />
    </div>
  );
}
