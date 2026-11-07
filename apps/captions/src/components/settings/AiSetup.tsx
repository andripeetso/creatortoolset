import { useState } from "react";
import { Link } from "react-router";
import { Check, CheckCircle2, Circle, Copy } from "lucide-react";
import { DRIVERS, type ProviderCheck, type ProviderInstance, type ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Device = ProvidersView["devices"][number];

/**
 * How to install and sign in each coding tool on a Mac, from their own docs (2026-11-06:
 * code.claude.com/docs/en/setup, github.com/openai/codex). The site never installs anything on a Mac
 * itself: that would make the relay a way to run commands there.
 */
const TOOLS = [
  { name: "Claude Code", install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude", how: "then follow the browser prompts (Pro, Max or a Console account)" },
  { name: "Codex", install: "npm install -g @openai/codex", signIn: "codex", how: "then pick Sign in with ChatGPT" },
];

/**
 * Settings → AI providers, first: the steps a Mac needs before the AI answers, each ticked from what the
 * server already knows (paired, online, the tools it reported, the providers on it, the last check).
 * Signing in can't be seen from here: a check that fails says so.
 */
export function AiSetup({
  devices,
  device,
  providers,
  checks,
  onAdd,
  onCheck,
}: {
  devices: Device[];
  device: Device | null;
  providers: ProviderInstance[];
  checks: Record<string, ProviderCheck | undefined>;
  onAdd: () => void;
  onCheck: (inst: ProviderInstance) => void;
}) {
  const installed = device?.report?.drivers.filter((d) => d.installed && DRIVERS.find((x) => x.id === d.driver)?.runs) ?? [];
  const ready = providers.find((p) => checks[p.id]?.ok);
  // what the CLI itself said in the Mac's report
  const signedOut = installed.length > 0 && installed.every((d) => d.signedIn === false);
  const steps = [
    {
      done: devices.length > 0,
      title: "Connect a Mac",
      body: (
        <>
          Install the Creator Toolset Mac app and sign in with this account. <Link to="/settings/devices" className="underline underline-offset-2">Devices</Link> has the download.
        </>
      ),
    },
    { done: !!device?.online, title: "Keep it online", body: <>Open the Creator Toolset app on {device?.name ?? "the Mac"}. It shows online here within a minute.</> },
    {
      done: installed.length > 0,
      title: "Install a coding tool on it",
      body: device?.report ? (
        <>
          None found on {device.name} yet. In Terminal on that Mac, install one:
          <Commands />
        </>
      ) : (
        <>The Mac hasn't reported its tools yet: wait a minute after it comes online.</>
      ),
    },
    {
      done: providers.length > 0,
      title: "Add it as a provider",
      body: (
        <>
          One tool signed in as one account.
          <Button size="sm" variant="outline" className="mt-2 block" onClick={onAdd}>
            Add provider
          </Button>
        </>
      ),
    },
    {
      done: !!ready,
      title: "Check it answers",
      body: (
        <>
          {signedOut && <span className="text-foreground">The tool on the Mac says it isn't signed in yet. </span>}
          A one-line test through the Mac. If it says to sign in, run the tool once in Terminal on that Mac ({TOOLS.map((t) => <code key={t.name} className="mx-0.5">{t.signIn}</code>)}) and sign in, then check again.
          {providers[0] && (
            <Button size="sm" variant="outline" className="mt-2 block" onClick={() => onCheck(providers.find((p) => p.enabled) ?? providers[0]!)}>
              Check {(providers.find((p) => p.enabled) ?? providers[0]!).name}
            </Button>
          )}
        </>
      ),
    },
  ];
  const next = steps.findIndex((s) => !s.done);

  if (next < 0) {
    return (
      <p className="mt-4 flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" /> Your AI is set up: {ready!.name} on {device?.name} answers.
      </p>
    );
  }
  return (
    <section className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
      <h3 className="text-sm font-medium">Set up your AI</h3>
      <ol className="mt-2 space-y-2">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-2 text-sm">
            {s.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <Circle className={cn("mt-0.5 h-4 w-4 shrink-0", i === next ? "text-violet-500" : "text-muted-foreground/50")} />}
            <div className="min-w-0">
              <p className={cn(s.done ? "text-muted-foreground" : i === next ? "text-foreground" : "text-muted-foreground")}>{s.title}</p>
              {i === next && <div className="mt-0.5 text-xs text-muted-foreground">{s.body}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Commands() {
  return (
    <div className="mt-1.5 space-y-2">
      {TOOLS.map((t) => (
        <div key={t.name}>
          <p className="text-foreground">{t.name}</p>
          <Command text={t.install} />
          <p className="mt-0.5">
            Sign in: run <code>{t.signIn}</code> once, {t.how}.
          </p>
        </div>
      ))}
    </div>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-0.5 flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-[11px] text-foreground">{text}</code>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
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
