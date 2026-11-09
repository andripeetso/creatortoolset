import { useEffect, useState, type ReactNode } from "react";
import type { WorkPrefs } from "@contracts/work-prefs";
import { INSTALL_LINE } from "@contracts/local-ai";
import { AiPanel } from "@/components/setup/AiPanel";
import { getComputers, type ComputerInfo, type ComputersView } from "./computers";

const NAME: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini CLI" };

/**
 * One computer's agents, as it reports them: installed and signed in, or not found. A computer that reports nothing says so.
 * Install and sign-in for a computer that is not this one are run in that computer's own Terminal, so the line is shown to paste.
 */
function remoteRows(c: ComputerInfo) {
  if (!c.drivers.length) return <p className="px-1 text-sm text-muted-foreground">Nothing reported yet. The Creator Toolset app there reports its agents while its AI is on.</p>;
  const missing = c.drivers.filter((d) => !d.installed && INSTALL_LINE[d.driver as keyof typeof INSTALL_LINE]);
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-xl border border-border/60 bg-card/40">
        {c.drivers.map((d) => (
          <li key={d.driver} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="font-medium">{NAME[d.driver] ?? d.driver}</span>
            <span className="text-xs text-muted-foreground">{!d.installed ? "Not found" : d.signedIn === false ? "Found, not signed in" : "Ready"}</span>
          </li>
        ))}
      </ul>
      {missing.map((d) => (
        <p key={d.driver} className="px-1 text-xs text-muted-foreground">
          To add {NAME[d.driver] ?? d.driver} there, paste this line into a Terminal on {c.name}:{" "}
          <code className="break-all font-mono text-foreground">{INSTALL_LINE[d.driver as keyof typeof INSTALL_LINE]}</code>
        </p>
      ))}
    </div>
  );
}

/** Step 2: one section per computer. This computer's agents are the Connect-your-AI panel; the others show what they report. */
export function AgentsStepView({ here, others, mine }: { here: string; others: ComputerInfo[]; mine: ReactNode }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-label={`Agents on ${here}`}>
        <h3 className="text-sm font-semibold">{here}</h3>
        {mine}
      </section>
      {others.map((c) => (
        <section key={c.id} className="space-y-3" aria-label={`Agents on ${c.name}`}>
          <h3 className="text-sm font-semibold">{c.name}</h3>
          {remoteRows(c)}
        </section>
      ))}
    </div>
  );
}

/** Step 2 container: loads the computers, and passes this computer's AI panel in as the first section. */
export function AgentsStep({ talk, onConnectedChange }: { talk: WorkPrefs["talk"]; onConnectedChange?: (on: boolean) => void }) {
  const [view, setView] = useState<ComputersView | null>(null);
  useEffect(() => {
    void getComputers().then(setView);
  }, []);
  return (
    <AgentsStepView
      here={view?.here.name ?? "This computer"}
      others={view?.others ?? []}
      mine={<AiPanel talk={talk} onConnectedChange={onConnectedChange} />}
    />
  );
}
