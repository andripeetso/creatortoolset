import { useEffect, useState } from "react";
import type { CliId, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { Check, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccessKeysSection } from "./AccessKeys";
import { ProviderLogo } from "./ProviderLogos";
import { installInMacAi } from "@/lib/thisMac";
import { Advanced, Card, ErrorRow, ListRow, LoadingRow, RowMenu, Section, Status, saveFailed, InUse } from "./ui";
import { shortVersion } from "./ProvidersSection";
import { fmtAgo, msg } from "./helpers";

/** The AI apps this page writes a command for. "other" is any app or script that takes an MCP address and a key. */
export type AiApp = "claude" | "codex" | "other";

const APPS: Record<AiApp, { name: string; logo?: string; after: string }> = {
  claude: { name: "Claude Code", logo: "claude", after: "Open a new Claude Code window." },
  codex: { name: "Codex", logo: "codex", after: "Open a new Codex window. It needs Codex 0.40 or newer." },
  other: { name: "Another app", after: "Add it as an MCP server in that app." },
};

const NAME = "creator-toolset";

/** What to paste into Terminal for one AI app: it adds this server to that app, with the key in it. Pure, so it is tested. */
export function commandFor(app: AiApp, url: string, key: string): string {
  if (app === "claude")
    return [
      `claude mcp remove --scope user ${NAME} 2>/dev/null`,
      `claude mcp add --transport http --scope user ${NAME} ${url} --header "Authorization: Bearer ${key}"`,
    ].join("\n");
  if (app === "codex")
    return [
      `codex mcp remove ${NAME} >/dev/null 2>&1`,
      `cat >> ~/.codex/config.toml <<'EOF'`,
      ``,
      `[mcp_servers.${NAME}]`,
      `url = "${url}"`,
      `http_headers = { Authorization = "Bearer ${key}" }`,
      `EOF`,
    ].join("\n");
  return `Address: ${url}\nHeader:  Authorization: Bearer ${key}`;
}

/** One AI app's key as the server lists it (api/auth.ts GET /api-key, `ai`). */
export interface AiKeyInfo {
  id: string;
  name: string;
  at: number;
  last4: string;
  usedAt?: number;
}

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/** What the Headless access rows read: the AI apps' keys and what this computer has. Shared by the page and setup's last screen. */
export function useOwnAi() {
  const [keys, setKeys] = useState<AiKeyInfo[] | null>(null);
  const [local, setLocal] = useState<LocalAiView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    fetch("/api/auth/api-key")
      .then((r) => json<{ ai?: AiKeyInfo[] }>(r))
      .then((k) => (setKeys(k.ai ?? []), setError(null)))
      .catch((e) => setError(msg(e)));
    fetch("/api/setup/ai", { signal: AbortSignal.timeout(20_000) })
      .then((r) => json<LocalAiView>(r))
      .then(setLocal)
      .catch(() => setLocal({ local: false, rows: [] }));
  };
  useEffect(() => {
    load();
  }, []);

  const disconnect = (id: string) =>
    fetch(`/api/auth/api-key?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((r) => json<{ ai?: AiKeyInfo[] }>(r))
      .then((k) => setKeys(k.ai ?? []))
      .catch((e) => (saveFailed(msg(e)), void load()));
  return { keys, local, error, load, disconnect };
}

/**
 * Settings → Headless access: the other way round from Providers. Providers is the AI the app uses; this page lets your own AI
 * app (Claude Code, Codex, a script) use the app, as you, each with a key of its own.
 * On the computer the server runs on, each AI app found is a row and its button does the work (Sign in, Update, Install);
 * Command shows the same install as a line to run yourself.
 * On a server that is not this computer the rows and their Install are the same: the Mac app adds it to the AI app on
 * your Mac itself; in a browser, where nothing can run on your computer, the click shows the line to run in Terminal.
 */
export function OwnAiSection() {
  const { keys, local, error, load, disconnect } = useOwnAi();

  const here = local?.local ? connectableRows(local) : [];
  // the apps with a row of their own above are not listed again under Installed in
  const rowed = local?.local ? here.map((r) => r.name) : REMOTE_APPS.map((a) => APPS[a].name);
  const listed = (keys ?? []).filter((k) => !rowed.includes(k.name));

  return (
    <>
      <Section id="connect-ai" title="Use Creator Toolset from Claude Code or Codex">
        <p className="px-0.5 text-sm text-muted-foreground">
          Install it in your AI app once. From then on it can find your clips, start edits and work in your Workshop projects, as you, without this window open.
        </p>
        {!local || !keys ? (
          error ? <Card><ErrorRow title="Couldn't load your AI apps" detail={error} retry={load} /></Card> : <Card><LoadingRow /></Card>
        ) : local.local ? (
          <Card>
            {here.map((r) => (
              <LocalAppRow key={r.id} row={r} aiKey={keys.find((k) => k.name === r.name)} onDone={load} onDisconnect={disconnect} />
            ))}
            <OtherAppRow onMade={load} />
          </Card>
        ) : (
          <Card>
            {REMOTE_APPS.map((a) => (
              <RemoteAppRow key={a} app={a} aiKey={keys.find((k) => k.name === APPS[a].name)} onDone={load} onDisconnect={disconnect} />
            ))}
            <OtherAppRow onMade={load} />
          </Card>
        )}
      </Section>

      {keys && listed.length > 0 && (
        <Section title="Installed in">
          <Card>
            {listed.map((k) => (
              <ListRow key={k.id} icon={<AppIcon name={k.name} />} title={k.name} subtitle={usedText(k)} actions={<DisconnectMenu k={k} onDisconnect={disconnect} />} />
            ))}
          </Card>
        </Section>
      )}

      <Advanced summary="Keys for scripts">
        <AccessKeysSection />
      </Advanced>
    </>
  );
}

const usedText = (k: AiKeyInfo) =>
  [`Installed ${new Date(k.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, k.usedAt ? `last used ${fmtAgo(k.usedAt)}` : "not used yet"].join(" · ");

function DisconnectMenu({ k, onDisconnect }: { k: AiKeyInfo; onDisconnect: (id: string) => Promise<unknown> }) {
  return (
    <RowMenu
      label={`${k.name} actions`}
      items={[
        {
          label: "Remove",
          destructive: true,
          confirm: { title: `Remove from ${k.name}?`, body: "Its key stops working. Install it again for a new one.", ok: "Remove" },
          onSelect: () => onDisconnect(k.id),
        },
      ]}
    />
  );
}

/** The AI apps a row can install into on this computer: Claude Code and Codex, when found. */
export const connectableRows = (view: LocalAiView) =>
  view.rows.filter((r): r is LocalAiRow & { id: CliId } => r.kind === "cli" && r.found && (r.id === "claude" || r.id === "codex"));

/** What a row's button does next, from what the computer reports. Pure, so each state is tested. */
export function nextStep(row: LocalAiRow, key?: { usedAt?: number }): "signin" | "update" | "connect" | "connected" {
  if (row.signedIn === false) return "signin";
  if (row.mcp === "update") return "update";
  // installed by the button (added), or by its command and since used; a command never run is not installed
  return key && (row.mcp === "added" || key.usedAt) ? "connected" : "connect";
}

const STEP_ROUTE = { signin: "/api/setup/ai/signin", update: "/api/setup/ai/update", connect: "/api/setup/ai/mcp" } as const;
const STEP_LABEL = { signin: ["Sign in", "Signing in…"], update: ["Update", "Updating…"], connect: ["Install", "Installing…"] } as const;

/**
 * One AI app on this computer. Install does it here (the same `mcp add` a person would type, with a key that is never
 * shown). A Codex too old for it shows Update beside a greyed Install, so the order is plain.
 */
export function LocalAppRow({ row, aiKey, onDone, onDisconnect }: { row: LocalAiRow & { id: CliId }; aiKey?: AiKeyInfo; onDone: () => void; onDisconnect: (id: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState<"signin" | "update" | "connect" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const step = nextStep(row, aiKey);

  const go = async (s: Exclude<typeof step, "connected">) => {
    setBusy(s);
    setFailed(null);
    try {
      const res = await fetch(STEP_ROUTE[s], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: row.id }) }).then((r) =>
        json<{ ok: boolean; message?: string; failed?: Array<{ message: string }> }>(r),
      );
      if (!res.ok) setFailed(res.failed?.[0]?.message ?? res.message ?? "It didn't work. Try again.");
    } catch (e) {
      setFailed(msg(e));
    } finally {
      setBusy(null);
      onDone();
    }
  };

  const version = shortVersion(row.version);
  const subtitle =
    step === "connected" && aiKey ? usedText(aiKey)
    : step === "update" ? `Version ${version ?? "?"} · update it first`
    : step === "signin" ? "Sign in to it first"
    : version ? `Version ${version}` : undefined;
  const button = (s: Exclude<typeof step, "connected">, primary: boolean, disabled = false) => (
    <Button size="sm" variant={primary ? "default" : "outline"} disabled={disabled || !!busy} onClick={() => void go(s)}>
      {busy === s ? STEP_LABEL[s][1] : failed && step === s ? "Try again" : STEP_LABEL[s][0]}
    </Button>
  );
  return (
    <ListRow
      icon={<ProviderLogo driver={row.id} className="size-4" />}
      title={row.name}
      subtitle={subtitle}
      status={failed ? <Status tone="broken">{failed}</Status> : undefined}
      actions={
        step === "connected" && aiKey ? (
          <>
            <InUse>Installed</InUse>
            <DisconnectMenu k={aiKey} onDisconnect={onDisconnect} />
          </>
        ) : step === "update" ? (
          <>
            {button("update", true)}
            {button("connect", false, true)}
          </>
        ) : step === "signin" ? (
          <>
            {button("signin", true)}
            {button("connect", false, true)}
          </>
        ) : step === "connect" ? (
          button("connect", true)
        ) : null
      }
    />
  );
}

/** Any other app or a script: the address and a key of its own, shown once. */
function OtherAppRow({ onMade }: { onMade: () => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const get = async () => {
    setBusy(true);
    try {
      const { key } = await fetch("/api/auth/api-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: APPS.other.name }) }).then((r) => json<{ key: string }>(r));
      setShown(commandFor("other", `${window.location.origin}/api/mcp`, key));
      onMade();
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <ListRow
        icon={<KeyRound />}
        title="Another app or a script"
        subtitle="Anything that takes an MCP server address and a key."
        actions={
          !shown && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void get()}>
              {busy ? "Making it…" : "Get address and key"}
            </Button>
          )
        }
      />
      {shown && (
        <div className="px-3 pb-3 sm:px-4">
          <CommandBox text={shown} />
        </div>
      )}
    </div>
  );
}

function AppIcon({ name }: { name: string }) {
  const app = (Object.keys(APPS) as AiApp[]).find((a) => APPS[a].name === name);
  const logo = app && APPS[app].logo;
  return logo ? <ProviderLogo driver={logo} className="size-4" /> : <KeyRound />;
}

/** The AI apps with a row of their own on a server that is not this computer. */
const REMOTE_APPS = ["claude", "codex"] as const;
// this browser's note of the key the Mac app installed for an app (its last four characters): the row then says
// Installed after a reload too, before the AI app has used it once
const MARK = (app: string) => `ct-own-ai-installed:${app}`;
const marked = (app: string): string | null => {
  try {
    return localStorage.getItem(MARK(app));
  } catch {
    return null;
  }
};

/**
 * One AI app on a server that is not this computer. Install makes the app a key of its own, then the Mac app adds the
 * server to that app on this Mac. In a browser nothing can run on your computer, so the same click shows the line to
 * run in Terminal (the key is in it, shown this once); the row says Installed once the app has used its key.
 */
function RemoteAppRow({ app, aiKey, onDone, onDisconnect }: { app: (typeof REMOTE_APPS)[number]; aiKey?: AiKeyInfo; onDone: () => void; onDisconnect: (id: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [byMac, setByMac] = useState<string | null>(() => marked(app));
  const installed = !!aiKey && (!!aiKey.usedAt || byMac === aiKey.last4);

  const install = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const { key } = await fetch("/api/auth/api-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: APPS[app].name }) }).then((r) => json<{ key: string }>(r));
      const done = await installInMacAi(app, key);
      if (done === true) {
        setCommand(null);
        setByMac(key.slice(-4));
        try {
          localStorage.setItem(MARK(app), key.slice(-4));
        } catch {
          /* private mode: the row says Installed until the page is closed */
        }
      } else if (done) setFailed(done);
      else setCommand(commandFor(app, `${window.location.origin}/api/mcp`, key));
    } catch (e) {
      setFailed(msg(e));
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <div>
      <ListRow
        icon={<ProviderLogo driver={app} className="size-4" />}
        title={APPS[app].name}
        subtitle={installed && aiKey ? usedText(aiKey) : command ? "Run this in Terminal, then open a new window of it." : undefined}
        status={failed ? <Status tone="broken">{failed}</Status> : undefined}
        actions={
          installed && aiKey ? (
            <>
              <InUse>Installed</InUse>
              <DisconnectMenu k={aiKey} onDisconnect={onDisconnect} />
            </>
          ) : (
            !command && (
              <Button size="sm" disabled={busy} onClick={() => void install()}>
                {busy ? "Installing…" : failed ? "Try again" : "Install"}
              </Button>
            )
          )
        }
      />
      {command && !installed && (
        <div className="px-3 pb-3 sm:px-4">
          <CommandBox text={command} />
        </div>
      )}
    </div>
  );
}

function CommandBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-foreground">{text}</pre>
      <div className="flex justify-end border-t border-border/50 px-2 py-1.5">
        <Button
          size="sm"
          variant={copied ? "ghost" : "outline"}
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => saveFailed("Couldn't copy it. Select the text and copy it."),
            )
          }
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
