import { useEffect, useState } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { DRIVERS, launchArgsAllowed, type ProviderCheck, type ProviderInstance } from "@contracts/providers";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { modelName } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { fmtAgo, inputCls } from "./helpers";
import { ProviderMark, type ProviderStatus, StatusText } from "./ProviderInstanceCard";
import { Row } from "./ui";

const NONE: string[] = [];

/**
 * The selected provider, inside its list card (no card of its own): the header with its logo, name and a reset of its
 * runtime overrides; then Status (with Check), Display name, Runtime (binary path, home folder, shadow home folder,
 * launch arguments), Environment (variable names; their values stay on the Mac), and Remove. Text fields save when they
 * lose focus or on Enter; each save goes through `onChange`.
 */
export function ProviderDetail({
  inst,
  status,
  check,
  checking,
  canCheck,
  used,
  runHere,
  onChange,
  onCheck,
  onSignIn,
  onRunHere,
  onRemove,
}: {
  inst: ProviderInstance;
  status: ProviderStatus;
  check?: ProviderCheck;
  checking: boolean;
  /** a check can run now: the Mac is online and no check is running */
  canCheck: boolean;
  /** what uses this provider ("the default", job names): Remove waits until another is picked */
  used: string[];
  /** the name of the Mac this page is on, when the provider runs nowhere yet (its Mac was never picked) */
  runHere?: string;
  onChange: (patch: Partial<ProviderInstance>) => void;
  onCheck: () => void;
  /** set only where the Mac app shows this page and the provider is on it: opens the CLI's sign-in in Terminal */
  onSignIn?: () => void;
  /** a provider with no Mac: runs it on the Mac this page is on */
  onRunHere?: () => void;
  onRemove: () => void;
}) {
  const driver = DRIVERS.find((d) => d.id === inst.driver);
  const hasRuntime = !!(inst.binaryPath || inst.shadowHomePath || inst.launchArgs?.length || inst.envNames?.length);
  return (
    <section aria-label={`${inst.name} settings`} className="min-w-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <ProviderMark inst={inst} className="h-6 w-6" />
        <h2 className="min-w-0 flex-1 text-base font-semibold text-foreground">{inst.name}</h2>
        <button
          type="button"
          aria-label="Reset runtime settings"
          title="Clear the binary path, shadow home, launch arguments and variable names"
          disabled={!hasRuntime}
          onClick={() => onChange({ binaryPath: undefined, shadowHomePath: undefined, launchArgs: undefined, envNames: undefined })}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      <Row
        label="Status"
        hint={
          checking ? "Checking… up to a minute" : check?.ok ? `Checked ${fmtAgo(check.at)}${check.model ? ` · ${modelName(check.model)}` : ""} · ${(check.ms / 1000).toFixed(1)} s` : undefined
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusText status={status} />
          {onRunHere && runHere && (
            <Button variant="outline" size="sm" onClick={onRunHere}>
              Run on {runHere}
            </Button>
          )}
          {!onRunHere && (
            <Button variant="outline" size="sm" onClick={onCheck} disabled={!canCheck}>
              Check
            </Button>
          )}
          {!onRunHere && onSignIn && (
            <Button variant="outline" size="sm" onClick={onSignIn}>
              Sign in
            </Button>
          )}
        </div>
      </Row>
      <Row label="Display name">
        <TextField label="Display name" value={inst.name} placeholder={driver?.label} onCommit={(v) => onChange({ name: v.trim() || inst.name })} />
      </Row>

      <div className="px-4 pb-1 pt-6">
        <h3 className="text-sm font-semibold text-foreground">Runtime</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Where the Mac finds the program and its folders. Blank uses the usual ones.</p>
      </div>
      <Row label="Binary path" hint="The full path to the program on this Mac.">
        <TextField label="Binary path" value={inst.binaryPath ?? ""} placeholder="Default: the program on the Mac's PATH" onCommit={(v) => onChange({ binaryPath: v.trim() || undefined })} />
      </Row>
      <Row label="Home path" hint={driver?.homeEnv ? `Sent as ${driver.homeEnv}.` : "The folder the program keeps its settings in."}>
        <TextField label="Home path" value={inst.home ?? ""} placeholder="Default folder" onCommit={(v) => onChange({ home: v.trim() || undefined })} />
      </Row>
      <Row label="Shadow home path" hint="A second folder for the same program, sharing its history.">
        <TextField label="Shadow home path" value={inst.shadowHomePath ?? ""} placeholder="Not set" onCommit={(v) => onChange({ shadowHomePath: v.trim() || undefined })} />
      </Row>
      {launchArgsAllowed(inst.driver) && (
        <Row label="Launch arguments" hint="Only for a local ACP command: one literal argument per row, in launch order.">
          <ListEditor label="Launch argument" addLabel="Add argument" items={inst.launchArgs} onCommit={(list) => onChange({ launchArgs: list.length ? list : undefined })} />
        </Row>
      )}

      <div className="px-4 pb-1 pt-6">
        <h3 className="text-sm font-semibold text-foreground">Environment</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Variable names only. Each value is kept in this Mac's Keychain, never on the server.</p>
      </div>
      <div className="px-4 py-3">
        <ListEditor
          label="Variable"
          addLabel="Add variable"
          placeholder="CURSOR_API_KEY"
          items={inst.envNames}
          onCommit={(list) => onChange({ envNames: list.length ? list : undefined })}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="text-xs text-muted-foreground">{used.length ? `Used by ${used.join(", ")}.` : ""}</span>
        <ConfirmButton
          label="Remove"
          confirmLabel="Click again"
          disabled={used.length > 0}
          title={used.length ? `Used by ${used.join(", ")}. Pick another there first.` : "Remove this provider"}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300"
          armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
          onConfirm={onRemove}
        />
      </div>
    </section>
  );
}

/** A single-line text setting. Its value is saved when the field loses focus or on Enter, not on every key. */
export function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={cn(inputCls, "w-full sm:w-80")}
    />
  );
}

/**
 * A list of short texts (launch arguments, variable names). Rows save when they lose focus; a removed row saves at once.
 * Blank rows are not kept.
 */
function ListEditor({
  label,
  addLabel,
  placeholder,
  items,
  onCommit,
}: {
  label: string;
  addLabel: string;
  placeholder?: string;
  items: string[] | undefined;
  onCommit: (list: string[]) => void;
}) {
  const list = items ?? NONE;
  const [draft, setDraft] = useState<string[]>(list);
  useEffect(() => setDraft(list), [list]);
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return (
    <div className="w-full space-y-1.5 sm:w-80">
      {draft.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            aria-label={`${label} ${i + 1}`}
            value={item}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
            onBlur={() => {
              if (clean(draft).join("\n") !== list.join("\n")) onCommit(clean(draft));
            }}
            className={cn(inputCls, "min-w-0 flex-1")}
          />
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
            onClick={() => {
              const next = draft.filter((_, j) => j !== i);
              setDraft(next);
              onCommit(clean(next));
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground" onClick={() => setDraft((d) => [...d, ""])}>
        <Plus className="h-3.5 w-3.5" /> {addLabel}
      </Button>
    </div>
  );
}
