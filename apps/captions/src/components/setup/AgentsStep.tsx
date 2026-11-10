import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { CliId } from "@contracts/local-ai";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { useAuth } from "@/lib/auth";
import { AiPanel, ROW_NAME, ROW_SUB } from "@/components/setup/AiPanel";
import { HERE } from "@/components/setup/ConnectStep";
import { getComputers, type ComputerInfo, type ComputersView } from "./computers";

const AGENTS = ["codex", "claude", "gemini"] as const;
const ROW = "flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3";

/**
 * One other computer's AIs, as it reports them. Install and sign-in run on that computer's own app, so a missing
 * AI is only named here: its Agents step installs it. Gemini is listed only where its tool is installed.
 */
function remoteRows(c: ComputerInfo) {
  const agents = c.drivers.filter(
    (d) => (AGENTS as readonly string[]).includes(d.driver) && (d.driver !== "gemini" || d.installed),
  );
  if (!agents.length) return <p className="text-sm text-muted-foreground">Nothing reported yet. Open Creator Toolset on {c.name}, and its AIs show up here.</p>;
  return (
    <ul className="space-y-2">
      {agents.map((d) => {
        const id = d.driver as CliId;
        return (
          <li key={d.driver} className={ROW}>
            <ProviderLogo driver={d.driver} className="mt-0.5 size-5" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">{ROW_NAME[id]}</p>
              <p className="text-xs text-muted-foreground">{ROW_SUB[id]}</p>
              {!d.installed && <p className="text-xs">Not installed on {c.name}. Open Creator Toolset there and press Install.</p>}
              {d.installed && d.signedIn === false && <p className="text-xs text-muted-foreground">Not signed in on {c.name} yet.</p>}
            </div>
            {d.installed && d.signedIn !== false && <Check aria-label={`${ROW_NAME[id]} is connected on ${c.name}`} className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Stage 2, "Connect your AI": one section per computer that is picked on the Connect step. This computer's section
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
  // hosted: every computer of the account is shown (the Connect picks don't apply to them)
  const shownOthers = hosted ? others : others.filter((c) => picked.has(c.id));
  const showHere = !hosted && picked.has(HERE);
  if (!showHere && !shownOthers.length)
    return hosted ? (
      <p className="text-sm text-muted-foreground">
        No computer is connected yet. Download the{" "}
        <a className="text-foreground underline" href="https://creatortoolset.com/download">Creator Toolset Mac app</a> on the computer you work on, and its AI shows up here.
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">No computer is picked. Go back and pick one to set up its AI.</p>
    );
  // a computer's name is a heading only when another computer is listed too; with this computer alone there is none
  const named = shownOthers.length > 0;
  return (
    <div className="space-y-6">
      {showHere && (
        <section className="space-y-3" aria-label={`AI on ${here}`}>
          {named && <h3 className="text-sm font-semibold">{here}</h3>}
          {mine}
        </section>
      )}
      {shownOthers.map((c) => (
        <section key={c.id} className="space-y-3" aria-label={`AI on ${c.name}`}>
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
