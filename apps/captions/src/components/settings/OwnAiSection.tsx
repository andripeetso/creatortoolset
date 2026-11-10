import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { CliId, LocalAiRow, LocalAiView, SignInResult } from "@contracts/local-ai";
import { Button } from "@/components/ui/button";
import { getComputers, type ComputerInfo } from "@/components/setup/computers";
import { AccessKeysSection } from "./AccessKeys";
import { ProviderLogo } from "./ProviderLogos";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section, Status, saveFailed } from "./ui";
import { msg } from "./helpers";

/** A page that waits this long for the Mac's answer shows a row with Try again, not a spinner for ever. */
const WAIT_MS = 20_000;

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}
const getAi = () => fetch("/api/setup/ai", { signal: AbortSignal.timeout(WAIT_MS) }).then((r) => json<LocalAiView>(r));
const errorText = (e: unknown) => (e instanceof Error && e.name === "TimeoutError" ? "It took too long to answer. Try again." : msg(e));

/** The AI apps this page can connect (Claude Code, Codex; Gemini has no key path). */
export const connectableRows = (view: LocalAiView) =>
  view.rows.filter((r): r is LocalAiRow & { id: CliId } => r.kind === "cli" && r.found && r.mcp !== "n/a" && r.id !== "gemini");

const NAMES: Partial<Record<string, string>> = { claude: "Claude Code", codex: "Codex" };

/**
 * Settings → Use from your AI: the app gives your own AI (Claude Code, Codex) a key, so it can work here as you. Each AI app
 * found on this computer is one row. Access keys (for AIs and scripts) sit below.
 */
export function OwnAiSection() {
  return (
    <>
      <ConnectAiSection />
      <AccessKeysSection />
    </>
  );
}

/** What the rows need from the page's state: which row is busy, and the last failure per AI app. */
export interface ConnectState {
  busy: CliId | null;
  signing: CliId | null;
  failed: Partial<Record<CliId, string>>;
  signFailed: Partial<Record<CliId, string>>;
}

/**
 * "Use Creator Toolset from your AI": the AI apps on this computer (one row each, with Sign in or Connect), or, on a hosted
 * server, the AI apps on the computers that are online now. The other way round from Providers: those are the AIs the app
 * uses; these are the AI apps that use the app.
 */
export function ConnectAiSection() {
  const [view, setView] = useState<{ ai: LocalAiView; others: ComputerInfo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ConnectState>({ busy: null, signing: null, failed: {}, signFailed: {} });

  const load = () => {
    setError(null);
    getAi()
      .then(async (ai) => ({ ai, others: ai.local ? [] : ((await getComputers())?.others ?? []) }))
      .then(setView)
      .catch((e) => setError(errorText(e)));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (id: CliId) => {
    setState((s) => ({ ...s, busy: id, failed: { ...s.failed, [id]: undefined } }));
    try {
      const res = await fetch("/api/setup/ai/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => json<{ ok: boolean; failed: Array<{ id: CliId; message: string }>; message?: string }>(r));
      const mine = res.failed.find((x) => x.id === id);
      if (mine || !res.ok) setState((s) => ({ ...s, failed: { ...s.failed, [id]: mine?.message ?? res.message ?? "it could not be added" } }));
    } catch (e) {
      setState((s) => ({ ...s, failed: { ...s.failed, [id]: errorText(e) } }));
    } finally {
      setState((s) => ({ ...s, busy: null }));
      load();
    }
  };

  const signIn = async (id: CliId) => {
    setState((s) => ({ ...s, signing: id, signFailed: { ...s.signFailed, [id]: undefined } }));
    try {
      const res = await fetch("/api/setup/ai/signin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => json<SignInResult>(r));
      if (!res.ok) setState((s) => ({ ...s, signFailed: { ...s.signFailed, [id]: res.message ?? "it did not start" } }));
    } catch (e) {
      setState((s) => ({ ...s, signFailed: { ...s.signFailed, [id]: errorText(e) } }));
    } finally {
      setState((s) => ({ ...s, signing: null }));
      load();
    }
  };

  return (
    <Section id="connect-ai" title="Use Creator Toolset from your AI">
      <Card>
        {!view ? (
          error ? <ErrorRow title="Couldn't load your AI apps" detail={error} retry={load} /> : <LoadingRow />
        ) : view.ai.local ? (
          <ConnectAiRows view={view.ai} state={state} onAdd={(id) => void add(id)} onSignIn={(id) => void signIn(id)} />
        ) : (
          <OtherComputerRows others={view.others} />
        )}
      </Card>
    </Section>
  );
}

/** The rows for a loaded view on this computer: pure, so each state can be checked without a server. */
export function ConnectAiRows({ view, state, onAdd, onSignIn }: { view: LocalAiView; state: ConnectState; onAdd: (id: CliId) => void; onSignIn: (id: CliId) => void }) {
  const rows = connectableRows(view);
  if (rows.length === 0)
    return <EmptyRow title="Use the app from Claude, ChatGPT or a script" description="Your own AI can read and work in your projects here." />;
  return (
    <>
      {rows.map((r) => (
        <AiRow
          key={r.id}
          row={r}
          busy={state.busy === r.id}
          signing={state.signing === r.id}
          failed={state.failed[r.id]}
          signFailed={state.signFailed[r.id]}
          onAdd={() => onAdd(r.id)}
          onSignIn={() => onSignIn(r.id)}
        />
      ))}
    </>
  );
}

/**
 * On a hosted server the AI apps are on the person's computers that are online now: one row per AI app each of them
 * reports. Signed in is quiet ("Connected"); not signed in says where to fix it (the sign-in happens on that computer).
 * An offline computer is left out: its AI can't be reached, so it is not listed as if it could.
 */
export function OtherComputerRows({ others }: { others: ComputerInfo[] }) {
  const rows = others.filter((c) => c.online).flatMap((c) => c.drivers.filter((d) => d.installed && NAMES[d.driver]).map((d) => ({ c, d })));
  if (rows.length === 0)
    return <EmptyRow title="Connect your AI from the Mac app" description="Claude Code and Codex run on a Mac. Open Creator Toolset on that Mac to connect them." />;
  return (
    <>
      {rows.map(({ c, d }) => (
        <ListRow
          key={`${c.id}-${d.driver}`}
          icon={<ProviderLogo driver={d.driver as CliId} className="size-4" />}
          title={NAMES[d.driver] ?? d.driver}
          subtitle={c.name}
          actions={
            d.signedIn === false ? (
              <Status tone="attention">Not signed in. Sign in on {c.name}.</Status>
            ) : d.signedIn ? (
              <Status>Connected</Status>
            ) : undefined
          }
        />
      ))}
    </>
  );
}

function AiRow({ row, busy, signing, failed, signFailed, onAdd, onSignIn }: { row: LocalAiRow; busy: boolean; signing: boolean; failed?: string; signFailed?: string; onAdd: () => void; onSignIn: () => void }) {
  let status: ReactNode = undefined;
  let action: ReactNode = null;
  let subtitle: string | undefined = row.version ? `Version ${row.version}` : undefined;
  if (row.signedIn === false) {
    status = signFailed ? <Status tone="broken">Couldn't sign in: {signFailed}</Status> : <Status tone="attention">Not signed in</Status>;
    action = (
      <Button size="xs" variant="outline" disabled={signing} onClick={onSignIn}>
        {signing ? "Signing in…" : "Sign in"}
      </Button>
    );
  } else if (row.mcp === "added") {
    action = <Status>Connected</Status>;
  } else if (row.mcp === "update") {
    status = <Status tone="attention">Needs an update first</Status>;
    action = row.updateCommand ? <CopyCommand text={row.updateCommand} /> : null;
    subtitle = row.updateCommand;
  } else if (failed) {
    status = <Status tone="broken">Couldn't add it: {failed}</Status>;
    action = (
      <Button size="xs" variant="outline" disabled={busy} onClick={onAdd}>
        Try again
      </Button>
    );
  } else {
    action = (
      <Button size="xs" variant="outline" disabled={busy} onClick={onAdd}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
    );
  }
  return (
    <ListRow
      icon={<ProviderLogo driver={row.id} className="size-4" />}
      title={row.name}
      subtitle={subtitle}
      status={status}
      actions={action}
    />
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Copy the update command"
      title={text}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => saveFailed("Couldn't copy it. Select the command and copy it."),
        )
      }
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
