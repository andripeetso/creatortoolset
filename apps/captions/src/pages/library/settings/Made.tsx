import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, Check, CircleOff, Clock } from "lucide-react";
import { LIBRARY_WORDS, MADE_KINDS, makesProxies, type LibraryMade, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, LoadingRow, Row, Section } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { aboutTime, aboutUsd } from "@/components/LibraryProcessing";
import { getMade, makeMissing, retryFailed, stopMade } from "@/lib/library";
import { useMe } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { faceBlurOn } from "../face-blur";
import { cn } from "@/lib/utils";

const n = (x: number) => x.toLocaleString();
const files = (x: number) => `${n(x)} ${x === 1 ? "file" : "files"}`;
const LOAD_FAILED = "Could not load what's made";

/**
 * What making the missing costs, in words: money for a paid key or an AI key, the API-price worth of an AI provider
 * sign-in's usage (counted toward its plan), free with the time it takes on the person's own machines.
 */
export function costWords(m: Pick<LibraryMade, "cost" | "usd" | "minutes" | "where" | "needs">): string {
  if (m.needs) return m.needs;
  const time = m.minutes ? aboutTime(m.minutes * 60) : "";
  if (m.cost === "free") return ["free", time].filter(Boolean).join(", ");
  const money =
    m.usd === undefined ? (m.cost === "paid" ? "paid" : "uses tokens") : m.where === "the AI provider sign-in" ? `${aboutUsd(m.usd)} of plan usage` : aboutUsd(m.usd);
  return [money, time].filter(Boolean).join(", ");
}

/** What a kind runs on: "Deepgram nova-3 on Deepgram", "FFmpeg on Studio Mac". */
export const engineLine = (m: Pick<LibraryMade, "engine" | "where">) => (m.engine ? `${m.engine}${m.where ? ` on ${m.where}` : ""}` : "");

/** Beside the count: the missing are mostly B-roll (when so), and the files this kind skips. */
export function missingWhy(m: Pick<LibraryMade, "missing" | "broll" | "skipped">): string {
  const broll = m.missing && m.broll && m.broll * 2 > m.missing ? "Mostly B-roll" : "";
  return [broll, m.skipped ? `${files(m.skipped.n)} skipped: ${m.skipped.why}` : ""].filter(Boolean).join(" · ");
}

/** What Make for the missing does, before it is pressed. */
export const makeWhat = (m: Pick<LibraryMade, "missing" | "where">) =>
  `queues ${n(m.missing)} ${m.missing === 1 ? "job" : "jobs"}${m.where ? ` that run on ${m.where}` : ""}, and Cancel takes off the ones still waiting`;

type Tone = "done" | "waiting" | "failed" | "off";
/**
 * A kind's state at a glance: failed (Retry), waiting (what for, or which computer makes it), off for new files with
 * what is missing, not made yet, done. `on`: its switch for new files; `auto`: sorted by itself, so it has no Make.
 */
export function stateOf(m: LibraryMade, on: boolean, auto = false): { tone: Tone; text: string } {
  if (!on) return { tone: "off", text: m.missing ? `Off · ${n(m.missing)} missing` : "Off" };
  if (m.failed) return { tone: "failed", text: `${files(m.failed)} failed` };
  if (m.stopped) return { tone: "waiting", text: `${files(m.stopped)} stopped` };
  if (m.queued) return { tone: "waiting", text: m.by ? `${files(m.queued)} queued for ${m.by}` : m.why ? `${files(m.queued)} waiting: ${m.why}` : `${files(m.queued)} queued` };
  if (m.needs && m.missing) return { tone: "waiting", text: m.needs };
  if (m.missing) return { tone: "waiting", text: auto ? `${n(m.missing)} not sorted yet` : `${n(m.missing)} missing` };
  return { tone: m.have ? "done" : "off", text: m.have ? "Done" : "No files of this kind" };
}

/** A kind's switch for new files, on unless turned off (a kind with none is always made); proxies and blurred copies as the Proxy workflow section reads them. */
const onFor = (k: (typeof MADE_KINDS)[number], library: LibrarySummary) =>
  k.kind === "proxy" ? makesProxies(library.settings) : k.kind === "blur" ? !!library.settings.blurFaces : k.setting ? library.settings[k.setting] !== false : true;

/**
 * The library's health at a glance (the status button): red when a kind failed, amber when one waits or is not made,
 * else green. Off kinds, and the ones sorted by themselves (nothing to press), count for nothing.
 */
export function healthOf(made: LibraryMade[], library: LibrarySummary): "done" | "waiting" | "failed" {
  const tones = made.flatMap((m) => {
    const k = MADE_KINDS.find((x) => x.kind === m.kind);
    return k && !k.auto ? [stateOf(m, onFor(k, library)).tone] : [];
  });
  return tones.includes("failed") ? "failed" : tones.includes("waiting") ? "waiting" : "done";
}

const ICON = { done: Check, waiting: Clock, failed: AlertCircle, off: CircleOff } as const;
const COLOR = { done: "text-emerald-700 dark:text-emerald-400", waiting: "text-amber-700 dark:text-amber-400", failed: "text-red-600 dark:text-red-400", off: "text-muted-foreground" } as const;

function State({ tone, text, rest }: { tone: Tone; text: string; rest: string }) {
  const Icon = ICON[tone];
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs">
      <Icon aria-hidden className={cn("size-3.5 shrink-0", COLOR[tone])} />
      <span className="min-w-0 break-words">
        <span className={cn("font-medium", COLOR[tone])}>{text}</span>
        {rest && <span className="text-muted-foreground"> · {rest}</span>}
      </span>
    </span>
  );
}

/**
 * What's made: one row per kind the library makes for its files, what it is, its state (done, waiting and why, failed
 * with Retry, off), how many have it, what it costs, and Make for the missing (the one thing that fills the files
 * already here; a confirm first when it costs). With `save` (Settings → Media Library) a kind with a switch has it,
 * "New files": made for each new file. Without (the library's Status view) `onSettings` opens the settings. One
 * component for both places. Blurred copies shows only with Face Blur (`faceBlur`: on in the settings' workspace; left
 * out, the window's) or in a library that blurs already; its New files switch is Blur faces (`onBlur`, which asks about
 * the files already here). Proxies' New files switch is Generate proxies (`onProxy`, which turns Upload's Proxies off with it).
 */
export function Made({ library, save, onSettings, faceBlur, onBlur, onProxy }: { library: LibrarySummary; save?: (s: Partial<LibrarySettings>) => Promise<unknown>; onSettings?: () => void; faceBlur?: boolean; onBlur?: (on: boolean) => void; onProxy?: (on: boolean) => void }) {
  const me = useMe();
  const blurHere = useWorkspace((st) => faceBlurOn(me, st.pluginsOff, st.currentProjectId));
  const blurs = (faceBlur ?? blurHere) || !!library.settings.blurFaces;
  const [made, setMade] = useState<LibraryMade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    return getMade(library.id).then(setMade, () => setError(LOAD_FAILED));
  }, [library.id]);
  useEffect(() => {
    let live = true;
    getMade(library.id).then(
      (m) => live && setMade(m),
      () => live && setError(LOAD_FAILED),
    );
    return () => {
      live = false;
    };
  }, [library.id]);

  const run = async (kind: string, what: string, go: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await go();
      await load();
    } catch {
      setError(`Could not ${what}`);
    } finally {
      setBusy(null);
    }
  };
  const make = async (m: LibraryMade, label: string) => {
    // one sentence: what runs it, what it costs, what pressing does (a blur has no job to cancel: it says what waits)
    const what = m.kind === "blur" ? "each file plays only on its own computer until its blurred copy is made" : makeWhat(m);
    const body = `${[engineLine(m), costWords(m), what].filter(Boolean).join(", ")}.`.replace(/^./, (c) => c.toUpperCase());
    if (!(await confirmDialog({ title: `Make ${label.toLowerCase()} for ${files(m.missing)}`, body, ok: `Make ${n(m.missing)}` }))) return;
    await run(`make-${m.kind}`, `make ${label.toLowerCase()}`, () => makeMissing(library.id, m.kind));
  };

  const link = onSettings ? (
    <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onSettings}>
      Library settings
    </Button>
  ) : undefined;
  return (
    <Section title={LIBRARY_WORDS.madeTitle} action={link}>
      <Card>
        {error && <ErrorRow title={error} retry={() => void load()} />}
        {!made && !error && <LoadingRow />}
        {made?.map((m) => {
          const k = MADE_KINDS.find((x) => x.kind === m.kind);
          if (!k || (k.kind === "blur" && !blurs)) return null;
          const on = onFor(k, library);
          const blur = k.kind === "blur";
          const state = stateOf(m, on, k.auto);
          const total = m.have + m.missing + m.queued + (m.failed ?? 0) + (m.stopped ?? 0);
          const rest = total && state.tone !== "done" ? `${n(m.have)} of ${n(total)} made` : "";
          const runs = engineLine(m);
          const why = missingWhy(m);
          // off: stopped or failed jobs are not wanted (no Retry); proxies and blurred copies off are not made at all (no Make)
          const retry = on && !!(m.failed || m.stopped);
          const makes = m.missing > 0 && !k.auto && (on || (k.kind !== "proxy" && !blur));
          const change = blur ? onBlur : k.kind === "proxy" && onProxy ? onProxy : k.setting && save ? (v: boolean) => void save({ [k.setting!]: v }) : undefined;
          return (
            <Row
              key={m.kind}
              title={k.label}
              description={k.about}
              status={
                <span className="flex flex-col gap-0.5">
                  <State tone={state.tone} text={state.text} rest={rest} />
                  {runs && <span>{`${runs}${m.missing && !k.auto && (!m.needs || !on) ? ` · ${costWords(m)}` : ""}`}</span>}
                  {why && <span>{why}</span>}
                </span>
              }
              control={
                change && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    New files
                    <Switch aria-label={`${k.label} for new files`} checked={on} onCheckedChange={change} />
                  </label>
                )
              }
            >
              {(retry || (m.queued > 0 && ((m.why && m.href) || (!k.auto && !k.ready && !blur))) || makes) && (
                <span className="flex flex-wrap items-center gap-2">
                  {retry && (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(`retry-${m.kind}`, "retry", () => retryFailed(library.id, m.kind))}>
                      {busy === `retry-${m.kind}` ? "Queueing" : "Retry"}
                    </Button>
                  )}
                  {m.queued > 0 && m.why && m.href && (
                    <Button variant="outline" size="sm" asChild>
                      <Link to={m.href}>Open settings</Link>
                    </Button>
                  )}
                  {/* a blur has no job here to cancel: Face Blur's own Stop holds it (Settings → Face Blur) */}
                  {m.queued > 0 && !k.auto && !k.ready && !blur && (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(`cancel-${m.kind}`, "cancel", () => stopMade(library.id, m.kind))}>
                      {busy === `cancel-${m.kind}` ? "Canceling" : "Cancel"}
                    </Button>
                  )}
                  {makes && (
                    <Button variant="outline" size="sm" title={makeWhat(m).replace(/^./, (c) => c.toUpperCase())} disabled={busy !== null || !!m.needs} onClick={() => void make(m, k.label)}>
                      {busy === `make-${m.kind}` ? "Queueing" : `Make ${n(m.missing)} missing`}
                    </Button>
                  )}
                </span>
              )}
            </Row>
          );
        })}
      </Card>
    </Section>
  );
}
