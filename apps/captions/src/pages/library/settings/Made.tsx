import { useCallback, useEffect, useState } from "react";
import { hostsProxies, LIBRARY_WORDS, MADE_COST_LABEL, MADE_KINDS, type LibraryMade, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, LoadingRow, Row, Section, Status } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { getMade, makeMissing } from "@/lib/library";

const n = (x: number) => x.toLocaleString();
const LOAD_FAILED = "Could not load what's made";

/** The cost line of a confirm: what pays, and about how much when it is known. */
export function costLine(m: Pick<LibraryMade, "cost" | "usd">): string {
  const about = m.usd ? `, about $${m.usd < 1 ? m.usd.toFixed(2) : Math.round(m.usd)}` : "";
  return m.cost === "tokens" ? `Uses tokens on the AI provider${about}.` : m.cost === "paid" ? `Uses a paid key${about}.` : "Free.";
}

/**
 * What's made: one row per kind the library makes for its files, with how many have it, how many lack it, what it
 * costs, and Make for the missing (the one thing that fills the files already here; a confirm first when it costs).
 * With `save` (Settings → Media Library) a kind with a switch has it, "New files": made for each new file. Without (the
 * library's Status view) the row says it and `onSettings` opens the settings. One component for both places.
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

  const make = async (m: LibraryMade, label: string) => {
    if (m.cost !== "free" && !(await confirmDialog({ title: `Make ${label.toLowerCase()} for ${n(m.missing)} files`, body: costLine(m), ok: `Make ${n(m.missing)}` }))) return;
    setBusy(m.kind);
    try {
      await makeMissing(library.id, m.kind);
      await load();
    } catch {
      setError(`Could not make ${label.toLowerCase()}`);
    } finally {
      setBusy(null);
    }
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
          const k = MADE_KINDS.find((x) => x.kind === m.kind)!;
          const on = k.setting ? library.settings[k.setting] !== false : true;
          const line = [`Made for ${n(m.have)}`, m.missing ? `${n(m.missing)} missing` : "", m.queued ? `${n(m.queued)} queued` : "", MADE_COST_LABEL[m.cost]].filter(Boolean).join(" · ");
          return (
            <Row
              key={m.kind}
              title={k.label}
              description={line}
              status={m.needs ? <Status tone="attention">{m.needs}</Status> : !save && k.setting && !on ? <Status>Off for new files</Status> : undefined}
              control={
                <span className="flex items-center gap-3">
                  {m.missing > 0 && (
                    <Button variant="outline" size="sm" disabled={busy !== null || !!m.needs} onClick={() => void make(m, k.label)}>
                      {busy === m.kind ? "Queueing" : `Make for ${n(m.missing)} missing`}
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
