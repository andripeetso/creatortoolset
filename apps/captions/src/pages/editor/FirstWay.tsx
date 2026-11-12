import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, Loader2 } from "lucide-react";
import { MAX_VERSIONS } from "@contracts/editor";
import type { StepRow } from "@contracts/editor-steps";
import { WORKING_SIZES } from "@contracts/editor-styles";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, Row, SettingsSelect } from "@/components/settings/ui";
import { createStyle, getEditSteps, markStylesAsked } from "@/lib/editor";
import { cn } from "@/lib/utils";
import { brollFolders, sizeKey, sizeOfKey, SIZE_OPTIONS } from "./EditingStyles";

/**
 * New edit's first screen for someone with no editing style who hasn't answered it yet: how they like to work, saved as
 * their first editing style, "My way", which New edit then opens on. Its own sheet (Editing styles tab) changes it later.
 * Edit in passes saves the style with passes on (each pass waits in Review for Carry on). Not now answers it too. `onDone` reads the styles again, which takes this screen away.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const WAYS = [
  { id: "full", title: "Full edit", sub: "Cut, B-roll and post-processing" },
  { id: "passes", title: "Edit in passes", sub: "The cut, then the B-roll: each waits for you in Review" },
  { id: "rough", title: "Rough cut only", sub: "The cut, nothing added" },
] as const;

export function FirstWay({ onDone }: { onDone: () => Promise<unknown> }) {
  const [way, setWay] = useState<(typeof WAYS)[number]["id"]>("full");
  const [versions, setVersions] = useState(2);
  const [size, setSize] = useState(sizeKey({ w: WORKING_SIZES[0].w, h: WORKING_SIZES[0].h }));
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [folder, setFolder] = useState("");
  const [rows, setRows] = useState<StepRow[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    brollFolders().then((f) => {
      setFolders(f);
      setFolder(f.find((x) => /b-?roll/i.test(x.name))?.id ?? "");
    }, () => {});
    getEditSteps().then((v) => {
      const installed = v.steps.filter((s) => s.state === "on");
      setRows(installed);
      setOn(new Set(installed.filter((s) => s.use).map((s) => s.id)));
    }, () => setRows([]));
  }, []);

  const finish = async (save: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await save();
      await onDone();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const full = way !== "rough";   // Full edit and Edit in passes both bring the B-roll and the steps
  const save = () =>
    createStyle({
      name: "My way",
      first: true,
      versions,
      size: sizeOfKey(size),
      ...(way === "passes" ? { passes: true } : {}),
      brollCollectionId: full ? folder || null : null,
      // Rough cut: no steps at all. Full edit: the ones switched on here (none installed: whatever Settings has in use)
      steps: !full ? [] : rows?.length ? rows.filter((r) => on.has(r.id)).map((r) => ({ id: r.id, values: r.values })) : null,
    });

  return (
    <div className="flex flex-col gap-5 p-4 pt-12">
      <div>
        <SheetTitle className="text-base">How do you like to work?</SheetTitle>
        <SheetDescription className="text-xs text-muted-foreground">You set this up once. Change it any time under Editing styles.</SheetDescription>
      </div>

      <div role="group" aria-label="How it should work" className="grid gap-2 sm:grid-cols-3">
        {WAYS.map((w) => (
          <button
            key={w.id}
            type="button"
            aria-pressed={way === w.id}
            onClick={() => setWay(w.id)}
            className={cn(
              "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
              way === w.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/60 hover:bg-accent/50",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{w.title}</span>
              <span className="block text-xs text-muted-foreground">{w.sub}</span>
            </span>
            {way === w.id && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-3" />
              </span>
            )}
          </button>
        ))}
      </div>

      <Card>
        <Row
          title="Versions"
          control={<SettingsSelect label="Versions" value={String(versions)} onValueChange={(v) => setVersions(Number(v))} options={Array.from({ length: MAX_VERSIONS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />}
        />
        <Row title="Working size" control={<SettingsSelect label="Working size" value={size} onValueChange={setSize} options={SIZE_OPTIONS} />} />
        {full && folders.length > 0 && (
          <Row
            title="B-roll folder"
            control={<SettingsSelect label="B-roll folder" value={folder || "none"} onValueChange={(v) => setFolder(v === "none" ? "" : v)} options={[{ value: "none", label: "None" }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />}
          />
        )}
      </Card>

      {full && rows && (
        <Card>
          {rows.length ? (
            rows.map((r) => (
              <Row
                key={r.id}
                title={r.title}
                control={<Switch checked={on.has(r.id)} aria-label={r.title} onCheckedChange={(v) => setOn((s) => { const n = new Set(s); if (v) n.add(r.id); else n.delete(r.id); return n; })} />}
              />
            ))
          ) : (
            <Row title="Post-processing" control={<Button asChild size="sm" variant="outline"><Link to="/community/tool/editor">Get plug-ins</Link></Button>} />
          )}
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" disabled={busy} onClick={() => void finish(save)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Continue
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void finish(markStylesAsked)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
