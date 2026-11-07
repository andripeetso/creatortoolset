import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace";
import type { Pack } from "@contracts/packs";
import { Notice } from "./ui";
import { msg } from "./helpers";
import { ContentsSummary, ContentsView, ScopeSelect, UnreviewedNote } from "./PacksShared";
import { checkPackFile, installPack } from "./packs-api";

/** Install from a .ctpack.json file: the checks first, then a preview, then Install with the warning above it. */
export function PacksFile() {
  const currentId = useWorkspace((s) => s.currentProjectId);
  const [checked, setChecked] = useState<{ pack: Pack; problems: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "project">("all");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    setChecked(null);
    setDone(null);
    setError(null);
    if (!file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setError("This file is not valid JSON.");
      return;
    }
    try {
      const r = await checkPackFile(raw);
      setChecked(!r.ok || !r.pack ? { pack: r.pack as Pack, problems: r.problems } : { pack: r.pack, problems: [] });
    } catch (e) {
      setError(msg(e));
    }
  };

  const install = async () => {
    if (!checked?.pack) return;
    setBusy(true);
    setError(null);
    try {
      const r = await installPack(checked.pack, scope === "project" ? (currentId ?? undefined) : undefined);
      setDone(`Installed ${checked.pack.name} ${checked.pack.version}.${r.kept ? ` Kept ${r.kept} you edited.` : ""}`);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-xs text-muted-foreground">Pick a pack file (.ctpack.json). It is checked before anything is installed.</p>
      <input
        type="file"
        accept=".json,.ctpack.json,application/json"
        aria-label="Pack file"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="mt-2 block w-full text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1 file:text-xs"
      />

      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}

      {checked && checked.problems.length > 0 && (
        <div className="mt-3 rounded-md bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
          <div className="font-medium">This pack didn&apos;t pass the checks:</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {checked.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {checked && checked.problems.length === 0 && (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium text-foreground">{checked.pack.name}</span>
              <span className="text-xs text-muted-foreground">v{checked.pack.version}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              by {checked.pack.author} · {checked.pack.license}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{checked.pack.description}</p>
            <div className="mt-1 text-xs text-muted-foreground">
              Adds: <ContentsSummary pack={checked.pack} />
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground underline">What it adds</summary>
              <div className="mt-2">
                <ContentsView pack={checked.pack} />
              </div>
            </details>
          </div>

          <UnreviewedNote />

          {!done && (
            <div className="flex flex-wrap items-center gap-2">
              <ScopeSelect value={scope} onChange={setScope} disabled={busy} />
              <Button size="sm" onClick={() => void install()} disabled={busy}>
                {busy ? "Installing…" : "Install"}
              </Button>
            </div>
          )}
        </div>
      )}

      {done && <div className="mt-3"><Notice>{done}</Notice></div>}
    </>
  );
}
