import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { useAuth } from "@/lib/auth";
import { AiPanel } from "@/components/setup/AiPanel";
import { HERE } from "@/components/setup/ConnectStep";
import { getComputers, type ComputerInfo, type ComputersView } from "./computers";

const NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
const AGENTS = ["claude", "codex", "gemini"] as const;
const ROW = "flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3";

/**
 * One other computer's agents, as it reports them. Install and sign-in run on that computer's own app, so a missing
 * agent is only named here: its Agents step installs it.
 */
function remoteRows(c: ComputerInfo) {
  const agents = c.drivers.filter((d) => (AGENTS as readonly string[]).includes(d.driver));
  if (!agents.length) return <p className="text-sm text-muted-foreground">Nothing reported yet. Open Creator Toolset on {c.name}, and its agents show up here.</p>;
  return (
    <ul className="space-y-2">
      {agents.map((d) => (
        <li key={d.driver} className={ROW}>
          <ProviderLogo driver={d.driver} className="mt-0.5 size-5" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{NAME[d.driver] ?? d.driver}</p>
            {!d.installed && <p className="text-xs">Not installed on {c.name}. Open Creator Toolset there and press Install.</p>}
            {d.installed && d.signedIn === false && <p className="text-xs text-muted-foreground">Not signed in on {c.name} yet.</p>}
          </div>
          {d.installed && d.signedIn !== false && <Check aria-label={`${NAME[d.driver] ?? d.driver} is ready on ${c.name}`} className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" />}
        </li>
      ))}
    </ul>
  );
}

/**
 * Stage 2, "Connect your agents": one section per computer that is picked on the Connect step. This computer's section
 * is the AI panel (it connects on a press); the other computers show what they report.
 */
export function AgentsStepView({
  here,
  others,
  picked,
  hosted = false,
  mine,
}: {
  here: string;
  others: ComputerInfo[];
  picked: ReadonlySet<string>;
  /** on a hosted server this server is not a computer of the person: its own section is left out */
  hosted?: boolean;
  mine: ReactNode;
}) {
  const shownOthers = others.filter((c) => picked.has(c.id));
  const showHere = !hosted && picked.has(HERE);
  if (!showHere && !shownOthers.length) return <p className="text-sm text-muted-foreground">No computer is picked. Go back and pick one to set up its agents.</p>;
  return (
    <div className="space-y-6">
      {showHere && (
        <section className="space-y-3" aria-label={`Agents on ${here}`}>
          <h3 className="text-sm font-semibold">{here}</h3>
          {mine}
        </section>
      )}
      {shownOthers.map((c) => (
        <section key={c.id} className="space-y-3" aria-label={`Agents on ${c.name}`}>
          <h3 className="text-sm font-semibold">{c.name}</h3>
          {remoteRows(c)}
        </section>
      ))}
    </div>
  );
}

/** Stage 2 container: loads the computers, and passes this computer's AI panel in as its section. */
export function AgentsStep({ picked, onConnectedChange }: { picked: ReadonlySet<string>; onConnectedChange?: (on: boolean) => void }) {
  const [view, setView] = useState<ComputersView | null>(null);
  const hosted = useAuth((s) => s.hosted);
  useEffect(() => {
    void getComputers().then(setView);
  }, []);
  return (
    <AgentsStepView
      here={view?.here.name ?? "This computer"}
      others={view?.others ?? []}
      picked={picked}
      hosted={hosted}
      mine={<AiPanel onConnectedChange={onConnectedChange} />}
    />
  );
}
