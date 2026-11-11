import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { DRIVERS, driverFields, EFFORTS, type Effort, type ProviderCheck, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { effortLabel, modelChoices, modelName } from "@/lib/providers";
import { fmtAgo } from "./helpers";
import { cn } from "@/lib/utils";
import { DriverMark, PROVIDER_ROW, type ProviderStatus } from "./ProviderInstanceCard";
import { InstallHelp, SignInHelp } from "./AiSetup";
import { Advanced, RowMenu, Row, SettingsSelect, Status, TextField, type RowMenuItem } from "./ui";

/**
 * One AI's settings: the right half of the Providers panel from `lg`, its own page below it. Rows with a line between
 * them, no cards of their own: Status, Name, Model, Thinking, and Advanced with only the fields the Mac reads for this
 * tool (driverFields). Remove is in the header's menu and asks first; a tool that a job uses can't be removed until that
 * job picks another.
 */
export function ProviderDetail({
  inst,
  status,
  check,
  checking,
  canTest,
  used,
  models,
  selection,
  computers,
  computerNote,
  backTo,
  onChange,
  onTest,
  onSignIn,
  onMove,
  onRemove,
}: {
  inst: ProviderInstance;
  status: ProviderStatus;
  check?: ProviderCheck;
  checking: boolean;
  /** a test can run now: the computer is online and no test is running */
  canTest: boolean;
  /** what uses this AI ("the default", job names) */
  used: string[];
  /** the models this AI offers; empty = the tool's own default */
  models: string[];
  /** the model and thinking level it really runs with (effectiveSelection): the same values the Default row shows */
  selection: { model: string; effort: Effort };
  /** the computers this AI can move to (only when it runs on none, or on one that was removed) */
  computers?: Array<{ id: string; name: string }>;
  /** the sentence about its computer: "Its computer was removed: pick another." */
  computerNote?: string;
  /** below `lg` this page is a sub-page: its back arrow goes here */
  backTo?: string;
  onChange: (patch: Partial<ProviderInstance>) => void;
  onTest: () => void;
  /** set only where the Mac app shows this page and the AI is on this Mac: opens the CLI's sign-in in Terminal */
  onSignIn?: () => void;
  onMove?: (deviceId: string) => void;
  onRemove: () => void;
}) {
  const driver = DRIVERS.find((d) => d.id === inst.driver);
  const fields = driverFields(inst.driver);
  const testTitle = "Sends one short question to check it answers.";
  // what is true when it works: the last answer, its model and how long it took
  const answered = check?.ok && !check.note
    ? `Answered ${fmtAgo(check.at)}${check.model ? ` · ${modelName(check.model)}` : ""}${check.ms > 0 ? ` · ${(check.ms / 1000).toFixed(1)} s` : ""}`
    : undefined;
  const menu: RowMenuItem[] = [
    {
      label: "Test now",
      tooltip: testTitle,
      onSelect: () => {
        if (!canTest) throw new Error(checking ? "It is being tested now." : "The computer is offline, so it can't be tested now.");
        onTest();
      },
    },
    used.length
      ? { label: "Remove", destructive: true, onSelect: () => { throw new Error(`${inst.name} is used by ${used.join(", ")}. Pick another there first.`); } }
      : { label: "Remove", destructive: true, onSelect: onRemove, confirm: { title: `Remove ${inst.name}?`, body: "Its settings are removed from this account.", ok: "Remove" } },
  ];
  // one line, always there, so nothing under it moves: what needs the person in its colour, else what is true. Laid out
  // as a flex row: set in a line of text, the status with its dot is a pixel taller than words alone, and a test
  // starting or ending moved every row under it by that pixel
  const statusLine = (
    <span className="flex min-w-0">
      {checking ? (
        "Checking…"
      ) : status.text && status.tone !== "neutral" ? (
        <Status tone={status.tone}>{status.text}</Status>
      ) : (
        [status.text, answered ?? (status.text ? "" : "Not tested yet")].filter(Boolean).join(" · ")
      )}
    </span>
  );
  return (
    <div className="min-w-0 [&>*+*]:border-t [&>*+*]:border-border/50">
      {/* as tall as a row of the list beside it, so the first line runs straight across the panel */}
      <div className={cn(PROVIDER_ROW, "flex items-center gap-2.5 px-3 sm:px-4")}>
        {backTo && (
          <Button asChild variant="ghost" size="icon-xs" className="lg:hidden" aria-label="Back to the AI list">
            <Link to={backTo}>
              <ArrowLeft />
            </Link>
          </Button>
        )}
        <DriverMark driver={inst.driver} className="size-5" />
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{inst.name}</h3>
        <RowMenu label={`More for ${inst.name}`} items={menu} />
      </div>

      <Row
        title="Status"
        description={statusLine}
        control={
          status.action === "test" ? (
            // only a failed check offers the retry here; a working AI shows no button ("Test now" is in the menu)
            <Button size="sm" variant="outline" className="min-w-28 justify-center" disabled={!canTest || checking} title={testTitle} onClick={onTest}>
              {checking ? "Testing…" : "Test again"}
            </Button>
          ) : status.action === "sign-in" && onSignIn ? (
            <Button size="sm" variant="outline" onClick={onSignIn}>
              Sign in
            </Button>
          ) : undefined
        }
      >
        {status.action === "install" && <InstallHelp driver={inst.driver} />}
        {status.action === "sign-in" && !onSignIn && <SignInHelp driver={inst.driver} computer="its computer" />}
        {check && !check.ok && check.error && <p className="break-words text-xs text-muted-foreground">{check.error}</p>}
      </Row>

      {computers && onMove && (
        <Row
          title="Computer"
          description={computerNote ? <Status tone="attention">{computerNote}</Status> : undefined}
          control={
            <SettingsSelect
              label="Computer"
              value="choose"
              onValueChange={(id) => id !== "choose" && onMove(id)}
              options={[{ value: "choose", label: "Choose" }, ...computers.map((c) => ({ value: c.id, label: c.name }))]}
            />
          }
        />
      )}

      <Row
        title="Name"
        control={<TextField label="Name" value={inst.name} placeholder={driver?.label} onCommit={(v) => onChange({ name: v.trim() || inst.name })} />}
      />
      <Row
        title="Model"
        description="Used for the Default, or a job that picks this AI."
        control={
          selection.model ? (
            <SettingsSelect
              label="Model"
              value={selection.model}
              onValueChange={(m) => onChange({ model: m })}
              options={modelChoices(models, selection.model).map((m) => ({ value: m, label: modelName(m) }))}
            />
          ) : (
            <span className="text-sm text-muted-foreground">Uses the tool's own default</span>
          )
        }
      />
      <Row
        title="Thinking"
        control={
          <SettingsSelect
            label="Thinking level"
            value={selection.effort}
            onValueChange={(e) => onChange({ effort: e as ProviderInstance["effort"] })}
            options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
          />
        }
      />

      {(fields.home || fields.program || fields.args || fields.env) && (
        <Advanced summary="Advanced">
          {fields.home && (
            <Row
              title="Account folder"
              description="Empty uses the tool's default folder."
              control={
                <TextField label="Account folder" value={inst.home ?? ""} placeholder="Default folder" onCommit={(v) => onChange({ home: v.trim() || undefined })} />
              }
            />
          )}
          {fields.program && (
            <Row
              title="Program"
              description="Full path to the program on this computer. Empty uses the one on its PATH."
              control={
                <TextField label="Program" value={inst.binaryPath ?? ""} placeholder="/usr/local/bin/…" onCommit={(v) => onChange({ binaryPath: v.trim() || undefined })} />
              }
            />
          )}
          {fields.args && (
            <Row title="Arguments" description="One per line, in order.">
              <LinesField label="Arguments" value={inst.launchArgs ?? []} onCommit={(list) => onChange({ launchArgs: list.length ? list : undefined })} />
            </Row>
          )}
          {fields.env && (
            <Row title="Variable names" description="Names only: their values stay on this computer.">
              <LinesField label="Variable names" value={inst.envNames ?? []} onCommit={(list) => onChange({ envNames: list.length ? list : undefined })} />
            </Row>
          )}
        </Advanced>
      )}
    </div>
  );
}

/** A list of short lines (arguments, variable names): saved when the box loses focus, blank lines dropped. */
function LinesField({ label, value, onCommit }: { label: string; value: string[]; onCommit: (list: string[]) => void }) {
  const text = value.join("\n");
  const [draft, setDraft] = useState(text);
  const [edited, setEdited] = useState(false);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <Textarea
      aria-label={label}
      rows={2}
      value={edited ? draft : text}
      spellCheck={false}
      className="w-full font-mono text-xs sm:w-72"
      onChange={(e) => {
        setEdited(true);
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (edited && lines(draft).join("\n") !== text) onCommit(lines(draft));
        setEdited(false);
      }}
    />
  );
}
