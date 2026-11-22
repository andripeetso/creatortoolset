import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, Check, CircleOff, Clock } from "lucide-react";
import { hostsProxies, LIBRARY_WORDS, MADE_COST_LABEL, MADE_KINDS, type LibraryMade, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, LoadingRow, Row, Section } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { aboutTime, aboutUsd } from "@/components/LibraryProcessing";
import { getMade, makeMissing, retryFailed, stopMade } from "@/lib/library";
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
  const time = m.minutes ? `${aboutTime(m.minutes * 60)}${m.where ? ` on ${m.where}` : ""}` : "";
  if (m.cost === "free") return ["free", time].filter(Boolean).join(", ");
  const money =
    m.usd === undefined ? (m.cost === "paid" ? "paid" : "uses tokens") : m.where === "the AI provider sign-in" ? `${aboutUsd(m.usd)} of usage at API prices, counted toward the plan's limits` : aboutUsd(m.usd);
  return [money, time].filter(Boolean).join(", ");
}

/** What a kind runs on: "Deepgram nova-3 on Deepgram", "FFmpeg on Studio Mac". */
export const engineLine = (m: Pick<LibraryMade, "engine" | "where">) => (m.engine ? `${m.engine}${m.where ? ` on ${m.where}` : ""}` : "");

/** Why the missing are missing, from the data: never made (mostly B-roll, when so), and the files this kind skips. */
export function missingWhy(m: Pick<LibraryMade, "missing" | "broll" | "skipped">): string {
  const never = m.missing ? `${files(m.missing)} never made${m.broll && m.broll * 2 > m.missing ? ", mostly B-roll" : ""}` : "";
  return [never, m.skipped ? `${files(m.skipped.n)} skipped: ${m.skipped.why}` : ""].filter(Boolean).join(" · ");
}

/** What Make for the missing does, before it is pressed. */
export const makeWhat = (m: Pick<LibraryMade, "missing" | "where">) =>
  `Queues ${n(m.missing)} ${m.missing === 1 ? "job" : "jobs"}${m.where ? ` that run on ${m.where}` : ""}; Stop takes back the ones still waiting`;

type Tone = "done" | "waiting" | "failed" | "off";
/**
 * A kind's state at a glance: failed (Retry), waiting (what for, or which computer makes it), off for new files with
 * what is missing, not made yet, done. `on`: its switch for new files; `auto`: sorted by itself, so it has no Make.
 */
export function stateOf(m: LibraryMade, on: boolean, auto = false): { tone: Tone; text: string } {
  if (m.failed) return { tone: "failed", text: `${files(m.failed)} failed` };
  if (m.queued) return { tone: "waiting", text: m.by ? `${files(m.queued)} queued for ${m.by}` : m.why ? `${files(m.queued)} waiting: ${m.why}` : `${files(m.queued)} queued` };
  if (m.needs && m.missing) return { tone: "waiting", text: m.needs };
  if (!on) return { tone: "off", text: m.missing ? `Off for new files · ${n(m.missing)} missing` : "Off for new files" };
  if (m.missing) return { tone: "waiting", text: auto ? `${files(m.missing)} not sorted yet` : `Not made for ${files(m.missing)}` };
  return { tone: m.have ? "done" : "off", text: m.have ? "Done" : "No files of this kind" };
}

/** A kind's switch for new files, on unless turned off (a kind with none is always made). */
const onFor = (k: (typeof MADE_KINDS)[number], library: LibrarySummary) => (k.setting ? library.settings[k.setting] !== false : true);

/** The library's health at a glance (the status button): red when a kind failed, amber when one waits or is not made, else green. Off kinds count for nothing. */
export function healthOf(made: LibraryMade[], library: LibrarySummary): "done" | "waiting" | "failed" {
  const tones = made.flatMap((m) => {
    const k = MADE_KINDS.find((x) => x.kind === m.kind);
    return k ? [stateOf(m, onFor(k, library), k.auto).tone] : [];
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
        <span className="text-muted-foreground"> · {rest}</span>
      </span>
    </span>
  );
}

/**
 * What's made: one row per kind the library makes for its files, what it is, its state (done, waiting and why, failed
 * with Retry, off), how many have it, what it costs, and Make for the missing (the one thing that fills the files
 * already here; a confirm first when it costs). With `save` (Settings → Media Library) a kind with a switch has it,
 * "New files": made for each new file. Without (the library's Status view) `onSettings` opens the settings. One
 * component for both places.
 */
export function Made({ library, save, onSettings }: { library: LibrarySummary; save?: (s: Partial<LibrarySettings>) => Promise<unknown>; onSettings?: () => void }) {
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
    const body = `${[engineLine(m), costWords(m)].filter(Boolean).join(", ")}. ${makeWhat(m)}.`;
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
          if (!k) return null;
          const on = onFor(k, library);
          const state = stateOf(m, on, k.auto);
          const total = m.have + m.missing + m.queued + (m.failed ?? 0);
          const rest = [total ? `${n(m.have)} of ${n(total)}` : "", MADE_COST_LABEL[m.cost]].filter(Boolean).join(" · ");
          const runs = engineLine(m);
          const why = missingWhy(m);
          return (
            <Row
              key={m.kind}
              title={k.label}
              description={k.about}
              status={
                <span className="flex flex-col gap-0.5">
                  <State tone={state.tone} text={state.text} rest={rest} />
                  {runs && <span>{`Runs on ${runs}${m.missing && !k.auto ? ` · ${costWords(m)} for ${files(m.missing)}` : ""}`}</span>}
                  {why && <span>{why}</span>}
                </span>
              }
              control={
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {!!m.failed && (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(`retry-${m.kind}`, "retry", () => retryFailed(library.id, m.kind))}>
                      {busy === `retry-${m.kind}` ? "Queueing" : "Retry"}
                    </Button>
                  )}
                  {m.queued > 0 && m.why && m.href && (
                    <Button variant="outline" size="sm" asChild>
                      <Link to={m.href}>Open settings</Link>
                    </Button>
                  )}
                  {m.queued > 0 && !k.auto && (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(`stop-${m.kind}`, "stop", () => stopMade(library.id, m.kind))}>
                      {busy === `stop-${m.kind}` ? "Stopping" : "Stop"}
                    </Button>
                  )}
                  {m.missing > 0 && !k.auto && (
                    <Button variant="outline" size="sm" title={makeWhat(m)} disabled={busy !== null || !!m.needs} onClick={() => void make(m, k.label)}>
                      {busy === `make-${m.kind}` ? "Queueing" : `Make for ${n(m.missing)} missing`}
                    </Button>
                  )}
                  {save && k.setting && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      New files
                      <Switch
                        aria-label={`${k.label} for new files`}
                        checked={on}
                        // Hosted proxies keep the proxy switch on (the Proxy workflow section says why)
                        disabled={k.setting === "proxy" && hostsProxies(library.settings.upload)}
                        onCheckedChange={(v) => void save({ [k.setting!]: v })}
                      />
                    </label>
                  )}
                </span>
              }
            />
          );
        })}
      </Card>
    </Section>
  );
}
